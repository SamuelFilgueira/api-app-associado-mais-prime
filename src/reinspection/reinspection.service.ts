import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { ReinspectionVehicleType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { FileUploadService } from '../common/services/file-upload.service';
import { CreateReinspectionDto } from './dto/create-reinspection.dto';
import { UpsertTemplatePhotoDto } from './dto/upsert-template-photo.dto';
import { MailService } from 'src/common/services/mail.service';

@Injectable()
export class ReinspectionService {
  private readonly logger = new Logger(ReinspectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly fileUploadService: FileUploadService,
  ) {}

  async create(dto: CreateReinspectionDto) {
    this.logger.log(
      `Iniciando create de revistoria | userVehicleId=${dto.userVehicleId} | vehicleType=${dto.vehicleType} | photos=${dto.photos?.length ?? 0} | codigoVeiculo=${dto.codigoVeiculo ?? 'N/A'}`,
    );

    if (!dto.photos?.length) {
      this.logger.warn(
        `Validação falhou no create: nenhuma foto enviada | userVehicleId=${dto.userVehicleId}`,
      );
      throw new BadRequestException('Pelo menos uma foto é obrigatória');
    }

    const invalidPhoto = dto.photos.find((p) => !p.nomeArquivo || !p.binario);
    if (invalidPhoto) {
      this.logger.warn(
        `Validação falhou no create: foto inválida detectada | nomeArquivo=${invalidPhoto.nomeArquivo ?? 'N/A'} | hasBinario=${Boolean(invalidPhoto.binario)}`,
      );
      throw new BadRequestException(
        'Cada foto precisa informar nomeArquivo e binario',
      );
    }
    const vehicle = await this.prisma.userVehicle.findUnique({
      where: { id: dto.userVehicleId },
    });

    if (!vehicle) {
      this.logger.warn(
        `Validação falhou no create: veículo não encontrado | userVehicleId=${dto.userVehicleId}`,
      );
      throw new NotFoundException('Veículo não encontrado');
    }

    this.logger.debug(
      `Veículo validado com sucesso | userVehicleId=${dto.userVehicleId} | chassi=${vehicle.chassi}`,
    );

    let photosWithUrl: Array<{
      nomeArquivo: string;
      codigoTipo?: number;
      binario: string;
      url: string;
    }>;

    try {
      photosWithUrl = await Promise.all(
        dto.photos.map(async (photo) => {
          const url =
            await this.fileUploadService.uploadReinspectionPhotoFromBase64(
              photo.binario,
              photo.nomeArquivo,
            );

          return {
            nomeArquivo: photo.nomeArquivo,
            codigoTipo: photo.codigoTipo,
            binario: photo.binario,
            url,
          };
        }),
      );
    } catch (error) {
      this.logger.error(
        `Falha ao salvar fotos da revistoria localmente | userVehicleId=${dto.userVehicleId}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new BadRequestException(
        'Falha ao processar as fotos em base64 para armazenamento local',
      );
    }

    // 2. Persiste a revistoria e as fotos como log antes de chamar a Hinova
    const reinspection = await this.prisma.reinspection.create({
      data: {
        userVehicleId: dto.userVehicleId,
        vehicleType: dto.vehicleType,
        photos: {
          create: photosWithUrl.map((p) => ({
            nomeArquivo: p.nomeArquivo,
            codigoTipo: p.codigoTipo ?? null,
            url: p.url,
            sentToHinova: false,
          })),
        },
      },
      include: { photos: true },
    });

    this.logger.log(
      `Revistoria persistida localmente | reinspectionId=${reinspection.id} | photos=${reinspection.photos.length}`,
    );

    // 3. Envia as fotos para a Hinova com binário base64
    const hinovaUrl = `https://api.hinova.com.br/api/sga/v2/veiculo/foto/cadastrar`;

    try {
      const payload: Record<string, unknown> = {
        foto: photosWithUrl.map((p) => ({
          nome_arquivo: p.nomeArquivo,
          ...(p.codigoTipo !== undefined ? { codigo_tipo: p.codigoTipo } : {}),
          binario: p.binario,
        })),
      };

      if (dto.codigoVeiculo !== undefined) {
        payload.codigo_veiculo = dto.codigoVeiculo;
      }

      this.logger.debug(
        `Enviando revistoria para Hinova | reinspectionId=${reinspection.id} | fotos=${dto.photos.length} | codigoVeiculo=${dto.codigoVeiculo ?? 'N/A'}`,
      );

      const response = await axios.post(hinovaUrl, payload, {
        headers: {
          Authorization: `Bearer ${process.env.SGA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      });

      this.logger.log(
        `Resposta da Hinova recebida | reinspectionId=${reinspection.id} | status=${response.status}`,
      );

      // 4. Atualiza cada ReinspectionPhoto com o retorno da Hinova
      if (Array.isArray(response.data)) {
        for (const result of response.data as Array<{
          nome_arquivo: string;
          situacao: string;
        }>) {
          const photo = reinspection.photos.find(
            (p) => p.nomeArquivo === result.nome_arquivo,
          );
          if (photo) {
            await this.prisma.reinspectionPhoto.update({
              where: { id: photo.id },
              data: {
                hinovaSituacao: result.situacao,
                sentToHinova: result.situacao === 'Inserido',
              },
            });
          }
        }
      }

      // 5. Avança status para EM_ANALISE apenas se a Hinova aceitou
      if (response.status < 400) {
        await this.prisma.reinspection.update({
          where: { id: reinspection.id },
          data: { status: 'EM_ANALISE' },
        });
        this.logger.log(
          `Status da revistoria atualizado para EM_ANALISE | reinspectionId=${reinspection.id}`,
        );
      } else {
        this.logger.warn(
          `Hinova retornou erro | reinspectionId=${reinspection.id} | status=${response.status} | response=${JSON.stringify(response.data)}`,
        );
      }

      try {
        await this.mailService.sendRevistoriaEmail(
          vehicle.chassi,
          photosWithUrl.map((photo) => photo.url),
        );
      } catch (emailError) {
        this.logger.error(
          `Falha ao enviar email de revistoria | reinspectionId=${reinspection.id} | userVehicleId=${dto.userVehicleId}`,
          emailError instanceof Error ? emailError.stack : undefined,
        );
      }

      return {
        reinspectionId: reinspection.id,
        hinovaResponse: response.data,
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Falha HTTP ao enviar fotos para a Hinova | reinspectionId=${reinspection.id} | status=${error.response?.status ?? 'N/A'} | response=${JSON.stringify(error.response?.data ?? null)}`,
          error.stack,
        );
      } else {
        this.logger.error(
          `Falha inesperada ao enviar fotos para a Hinova | reinspectionId=${reinspection.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      // Revistoria já salva como log — informa o cliente sobre a falha parcial
      throw new InternalServerErrorException(
        'Revistoria salva localmente, mas falhou ao enviar para a Hinova. Tente reenviar.',
      );
    }
  }

  async upsertTemplatePhoto(
    dto: UpsertTemplatePhotoDto,
    file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Foto do template é obrigatória');
    }

    const photoUrl =
      await this.fileUploadService.uploadReinspectionTemplatePhoto(file);

    // Se já existe um registro com esse vehicleType + ordem, remove a foto antiga
    const existing = await this.prisma.reinspectionTemplatePhoto.findUnique({
      where: {
        vehicleType_ordem: {
          vehicleType: dto.vehicleType,
          ordem: dto.ordem,
        },
      },
    });

    if (existing) {
      await this.fileUploadService.deleteReinspectionTemplatePhoto(
        existing.photoUrl,
      );
    }

    const result = await this.prisma.reinspectionTemplatePhoto.upsert({
      where: {
        vehicleType_ordem: {
          vehicleType: dto.vehicleType,
          ordem: dto.ordem,
        },
      },
      create: {
        vehicleType: dto.vehicleType,
        ordem: dto.ordem,
        photoUrl,
      },
      update: {
        photoUrl,
      },
    });

    return {
      id: result.id,
      vehicleType: result.vehicleType,
      ordem: result.ordem,
      photoUrl: result.photoUrl,
    };
  }

  async getTemplatePhotos(vehicleType?: string) {
    const where = vehicleType
      ? { vehicleType: vehicleType as ReinspectionVehicleType }
      : undefined;

    const photos = await this.prisma.reinspectionTemplatePhoto.findMany({
      where,
      orderBy: { ordem: 'asc' },
      select: {
        photoUrl: true,
        ordem: true,
        vehicleType: true,
      },
    });

    return photos;
  }

  async getStatusByUserVehicleId(userVehicleId: number) {
    const vehicle = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { id: true },
    });

    if (!vehicle) {
      throw new NotFoundException('Veículo não encontrado');
    }

    const latestReinspection = await this.prisma.reinspection.findFirst({
      where: { userVehicleId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!latestReinspection) {
      return {
        userVehicleId,
        hasReinspection: false,
        status: null,
      };
    }

    return {
      userVehicleId,
      hasReinspection: true,
      reinspectionId: latestReinspection.id,
      status: latestReinspection.status,
      createdAt: latestReinspection.createdAt,
      updatedAt: latestReinspection.updatedAt,
    };
  }

  async finalizeByUserVehicleId(userVehicleId: number) {
    const vehicle = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { id: true },
    });

    if (!vehicle) {
      throw new NotFoundException('Veículo não encontrado');
    }

    const latestReinspection = await this.prisma.reinspection.findFirst({
      where: { userVehicleId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });

    if (!latestReinspection) {
      throw new NotFoundException(
        'Nenhuma revistoria encontrada para este veículo',
      );
    }

    const updated = await this.prisma.reinspection.update({
      where: { id: latestReinspection.id },
      data: { status: 'FINALIZADA' },
      select: {
        id: true,
        userVehicleId: true,
        status: true,
        updatedAt: true,
      },
    });

    this.logger.log(
      `Revistoria finalizada com sucesso | reinspectionId=${updated.id} | userVehicleId=${updated.userVehicleId}`,
    );

    return {
      reinspectionId: updated.id,
      userVehicleId: updated.userVehicleId,
      status: updated.status,
      updatedAt: updated.updatedAt,
    };
  }
}

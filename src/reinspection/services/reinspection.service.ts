import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  ReinspectionPhotoStatus,
  ReinspectionStatus,
  ReinspectionVehicleType,
} from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { CreateReinspectionDto } from 'src/reinspection/dto/create-reinspection.dto';
import { AddPhotosDto } from 'src/reinspection/dto/add-photos.dto';
import { UpsertTemplatePhotoDto } from 'src/reinspection/dto/upsert-template-photo.dto';
import { MailService } from 'src/infra/mail/mail.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { TENANT } from 'src/config/tenant.config';
import { SgaAuthService } from 'src/shared/sga-auth.service';
import { SgaService } from 'src/sga/services/sga.service';
import { debugLog } from 'src/shared/debug-log.util';

@Injectable()
export class ReinspectionService {
  private readonly logger = new Logger(ReinspectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly fileUploadService: FileUploadService,
    private readonly sgaAuthService: SgaAuthService,
    private readonly sgaService: SgaService,
  ) {}

  private log(
    debugId: string | undefined,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    this.logger.log(debugLog(ReinspectionService.name, message, debugId, meta));
  }

  private warn(
    debugId: string | undefined,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    this.logger.warn(
      debugLog(ReinspectionService.name, message, debugId, meta),
    );
  }

  private error(
    debugId: string | undefined,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    this.logger.error(
      debugLog(ReinspectionService.name, message, debugId, meta),
    );
  }

  async create(dto: CreateReinspectionDto, _userId: unknown, debugId?: string) {
    const vehicle = await this.prisma.userVehicle.findUnique({
      where: { id: dto.userVehicleId },
    });

    if (!vehicle) {
      this.warn(debugId, 'Validação falhou no create: veículo não encontrado', {
        userVehicleId: dto.userVehicleId,
      });
      throw new NotFoundException('Veículo não encontrado');
    }

    const reinspection = await this.prisma.reinspection.create({
      data: {
        userVehicleId: dto.userVehicleId,
        vehicleType: dto.vehicleType,
        codigoVeiculo: dto.codigoVeiculo ?? null,
      },
    });

    return {
      reinspectionId: reinspection.id,
      status: reinspection.status,
      createdAt: reinspection.createdAt,
    };
  }

  async getDashboardTotals() {
    const [aprovadas, emAnalise, reprovadas, totalRevistorias] =
      await this.prisma.$transaction([
        this.prisma.reinspection.count({
          where: { status: ReinspectionStatus.APROVADA },
        }),
        this.prisma.reinspection.count({
          where: { status: ReinspectionStatus.EM_ANALISE },
        }),
        this.prisma.reinspection.count({
          where: { status: ReinspectionStatus.REPROVADA },
        }),
        this.prisma.reinspection.count(),
      ]);

    return {
      aprovadas,
      emAnalise,
      reprovadas,
      totalRevistorias,
    };
  }

  /**
   * Adiciona um lote de fotos a uma revistoria existente com status PENDENTE.
   * Pode ser chamado múltiplas vezes para envio incremental.
   */
  async addPhotos(reinspectionId: number, dto: AddPhotosDto, debugId?: string) {
    const reinspection = await this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: { id: true, status: true },
    });

    if (!reinspection) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    if (reinspection.status !== 'PENDENTE') {
      throw new BadRequestException(
        'Fotos só podem ser adicionadas a revistorias com status PENDENTE',
      );
    }

    const invalidPhoto = dto.photos.find((p) => !p.nomeArquivo || !p.binario);
    if (invalidPhoto) {
      throw new BadRequestException(
        'Cada foto precisa informar nomeArquivo e binario',
      );
    }

    let photosWithUrl: Array<{
      nomeArquivo: string;
      codigoTipo?: number;
      templatePhotoId?: number;
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
            templatePhotoId: photo.templatePhotoId,
            url,
          };
        }),
      );
    } catch (error) {
      this.error(debugId, 'Falha ao salvar fotos', {
        reinspectionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadRequestException(
        'Falha ao processar as fotos em base64 para armazenamento local',
      );
    }

    await this.prisma.reinspectionPhoto.createMany({
      data: photosWithUrl.map((p) => ({
        reinspectionId,
        nomeArquivo: p.nomeArquivo,
        codigoTipo: p.codigoTipo ?? null,
        templatePhotoId: p.templatePhotoId ?? null,
        url: p.url,
        status: 'PENDENTE' as unknown as ReinspectionPhotoStatus,
        sentToHinova: false,
      })),
    });

    const totalPhotos = await this.prisma.reinspectionPhoto.count({
      where: { reinspectionId },
    });

    return {
      reinspectionId,
      photosAdded: dto.photos.length,
      totalPhotos,
    };
  }

  /**
   * Finaliza o envio das fotos, disparando o e-mail de notificação para os analistas.
   * Requer ao menos uma foto e status PENDENTE.
   */
  async submitReinspection(reinspectionId: number, debugId?: string) {
    const reinspection = await this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: {
        id: true,
        userVehicleId: true,
        status: true,
        photos: { select: { url: true } },
        userVehicle: { select: { chassi: true, plate: true } },
      },
    });

    if (!reinspection) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    if (reinspection.status !== 'PENDENTE') {
      throw new BadRequestException(
        'Somente revistorias com status PENDENTE podem ser submetidas',
      );
    }

    if (reinspection.photos.length === 0) {
      throw new BadRequestException(
        'É necessário enviar pelo menos uma foto antes de submeter a revistoria',
      );
    }

    try {
      await this.mailService.sendRevistoriaEmail(
        reinspection.userVehicle.chassi,
        reinspection.userVehicle.plate,
        debugId,
        reinspection.photos
          .map((p) => p.url)
          .filter((url): url is string => url !== null),
      );
    } catch (emailError) {
      this.error(debugId, 'Falha ao enviar e-mail de revistoria', {
        reinspectionId,
        error:
          emailError instanceof Error ? emailError.message : String(emailError),
      });
    }

    return {
      reinspectionId: reinspection.id,
      status: reinspection.status,
      totalPhotos: reinspection.photos.length,
    };
  }

  async listAll() {
    const reinspections = await this.prisma.reinspection.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userVehicleId: true,
        vehicleType: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: {
          select: {
            chassi: true,
            plate: true,
          },
        },
        _count: {
          select: {
            photos: true,
          },
        },
      },
    });

    return reinspections.map(({ userVehicle, ...reinspection }) => ({
      ...reinspection,
      chassi: userVehicle.chassi,
      plate: userVehicle.plate,
    }));
  }

  async upsertTemplatePhoto(dto: UpsertTemplatePhotoDto, file: any) {
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
      photoUrl: this.fileUploadService.buildUrl(result.photoUrl),
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

    return photos.map((p) => ({
      ...p,
      photoUrl: this.fileUploadService.buildUrl(p.photoUrl),
    }));
  }

  async listRecent(limit?: number) {
    const normalizedLimit = Math.min(limit ?? 20, 100);

    const reinspections = await this.prisma.reinspection.findMany({
      take: normalizedLimit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userVehicleId: true,
        vehicleType: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: {
          select: {
            chassi: true,
            plate: true,
          },
        },
        _count: {
          select: {
            photos: true,
          },
        },
      },
    });

    return reinspections.map(({ userVehicle, ...reinspection }) => ({
      ...reinspection,
      chassi: userVehicle.chassi,
      plate: userVehicle.plate,
    }));
  }

  async getPhotosByReinspectionId(reinspectionId: number) {
    const reinspection = await this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: {
        id: true,
        userVehicle: {
          select: {
            chassi: true,
            plate: true,
          },
        },
      },
    });

    if (!reinspection) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    const photos = await this.prisma.reinspectionPhoto.findMany({
      where: { reinspectionId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        reinspectionId: true,
        nomeArquivo: true,
        codigoTipo: true,
        url: true,
        status: true,
        hinovaSituacao: true,
        sentToHinova: true,
        createdAt: true,
      },
    });

    return {
      reinspectionId,
      chassi: reinspection.userVehicle.chassi,
      plate: reinspection.userVehicle.plate,
      totalPhotos: photos.length,
      photos: photos.map((p) => ({
        ...p,
        url: this.fileUploadService.buildUrl(p.url),
      })),
    };
  }

  async getStatusByUserVehicleId(userVehicleId: number) {
    const vehicle = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { id: true, chassi: true, plate: true },
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
        chassi: vehicle.chassi,
        plate: vehicle.plate,
        hasReinspection: false,
        status: null,
      };
    }

    return {
      userVehicleId,
      chassi: vehicle.chassi,
      plate: vehicle.plate,
      hasReinspection: true,
      reinspectionId: latestReinspection.id,
      status: latestReinspection.status,
      createdAt: latestReinspection.createdAt,
      updatedAt: latestReinspection.updatedAt,
    };
  }

  async updateStatusByUserVehicleId(userVehicleId: number) {
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
      select: { id: true },
    });

    if (!latestReinspection) {
      return {
        userVehicleId,
        hasReinspection: false,
        status: null,
      };
    }

    const updatedReinspection = await this.prisma.reinspection.update({
      where: { id: latestReinspection.id },
      data: { status: 'EM_ANALISE' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      userVehicleId,
      hasReinspection: true,
      reinspectionId: updatedReinspection.id,
      status: updatedReinspection.status,
      createdAt: updatedReinspection.createdAt,
      updatedAt: updatedReinspection.updatedAt,
    };
  }

  async finalizeByUserVehicleId(userVehicleId: number, debugId?: string) {
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

    return {
      reinspectionId: updated.id,
      userVehicleId: updated.userVehicleId,
      status: updated.status,
      updatedAt: updated.updatedAt,
    };
  }

  async approveByUserVehicleId(userVehicleId: number, debugId?: string) {
    const vehicle = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { id: true, chassi: true, plate: true },
    });

    if (!vehicle) {
      throw new NotFoundException('Veículo não encontrado');
    }

    const latestReinspection = await this.prisma.reinspection.findFirst({
      where: { userVehicleId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userVehicleId: true },
    });

    if (!latestReinspection) {
      throw new NotFoundException(
        'Nenhuma revistoria encontrada para este veículo',
      );
    }

    const hasRejectedPhoto = await this.prisma.reinspectionPhoto.findFirst({
      where: {
        reinspectionId: latestReinspection.id,
        status: ReinspectionPhotoStatus.REPROVADA,
      },
      select: { id: true },
    });

    if (hasRejectedPhoto) {
      throw new BadRequestException(
        'Não é possível aprovar uma revistoria com foto reprovada',
      );
    }

    const updated = await this.prisma.reinspection.update({
      where: { id: latestReinspection.id },
      data: { status: 'APROVADA' },
      select: {
        id: true,
        userVehicleId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    try {
      await this.sendReinspectionToHinova(updated.id);
    } catch (error) {
      this.error(debugId, 'Falha ao enviar revistoria aprovada para Hinova', {
        reinspectionId: updated.id,
        userVehicleId: updated.userVehicleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.mailService.sendRevistoriaAprovadaEmail(
        vehicle.chassi,
        vehicle.plate,
        debugId,
      );
    } catch (emailError) {
      this.error(debugId, 'Falha ao enviar e-mail de aprovação', {
        reinspectionId: updated.id,
        chassi: vehicle.chassi,
        plate: vehicle.plate ?? 'N/A',
        error:
          emailError instanceof Error ? emailError.message : String(emailError),
      });
    }

    await this.tryCreateReinspectionBoleto(
      updated.userVehicleId,
      updated.id,
      vehicle.plate,
      'approve',
      debugId,
    );

    return {
      reinspectionId: updated.id,
      userVehicleId: updated.userVehicleId,
      status: updated.status,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  private async tryCreateReinspectionBoleto(
    userVehicleId: number,
    reinspectionId: number,
    plate: string | null,
    trigger: 'submit' | 'approve',
    debugId?: string,
  ) {
    if (!plate) {
      this.warn(
        debugId,
        'Boleto de reativação não criado: placa não disponível',
        {
          trigger,
          reinspectionId,
          userVehicleId,
        },
      );
      return;
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const existingOpenPayment = await this.prisma.reinspectionPayment.findFirst(
      {
        where: {
          userVehicleId,
          pago: false,
          boletoCriadoEm: { gte: oneHourAgo },
        },
        orderBy: { boletoCriadoEm: 'desc' },
        select: {
          id: true,
          nossoNumero: true,
          situacaoBoleto: true,
        },
      },
    );

    if (existingOpenPayment) {
      this.log(
        debugId,
        'Boleto de reativação já existente; nova criação ignorada',
        {
          trigger,
          reinspectionId,
          userVehicleId,
          paymentId: existingOpenPayment.id,
          nossoNumero: existingOpenPayment.nossoNumero ?? 'N/A',
          situacao: existingOpenPayment.situacaoBoleto,
        },
      );
      return;
    }

    try {
      await this.sgaService.criarBoletoReativacao(
        userVehicleId,
        plate,
        debugId,
      );
    } catch (boletoError) {
      this.error(debugId, 'Falha ao criar boleto de reativação', {
        trigger,
        reinspectionId,
        userVehicleId,
        error:
          boletoError instanceof Error
            ? boletoError.message
            : String(boletoError),
      });
    }
  }

  private async sendReinspectionToHinova(reinspectionId: number) {
    const reinspection = await this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: {
        id: true,
        codigoVeiculo: true,
        userVehicle: {
          select: {
            user: {
              select: {
                baseOrigin: true,
              },
            },
          },
        },
        photos: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            nomeArquivo: true,
            codigoTipo: true,
            url: true,
          },
        },
      },
    });

    if (!reinspection) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    const payloadPhotos = await Promise.all(
      reinspection.photos.map(async (photo) => ({
        photoId: photo.id,
        nome_arquivo: photo.nomeArquivo,
        codigo_tipo: photo.codigoTipo,
        binario: await this.readPhotoAsBase64(photo.url),
      })),
    );

    const payload: Record<string, unknown> = {
      foto: payloadPhotos.map((photo) => ({
        nome_arquivo: photo.nome_arquivo,
        ...(photo.codigo_tipo != null
          ? { codigo_tipo: photo.codigo_tipo }
          : {}),
        binario: photo.binario,
      })),
    };

    if (reinspection.codigoVeiculo != null) {
      payload.codigo_veiculo = reinspection.codigoVeiculo;
    }

    const hinovaUrl = `https://api.hinova.com.br/api/sga/v2/veiculo/foto/cadastrar`;
    const baseOrigin =
      reinspection.userVehicle?.user?.baseOrigin ?? TENANT.defaultBase;

    const response = await this.sgaAuthService.executeRequestWithAuth(
      baseOrigin,
      {
        method: 'POST',
        url: hinovaUrl,
        data: payload,
        headers: {
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      },
    );

    if (Array.isArray(response.data)) {
      const photosByNomeArquivo = new Map(
        payloadPhotos.map((photo) => [photo.nome_arquivo, photo.photoId]),
      );

      for (const result of response.data as Array<{
        nome_arquivo: string;
        situacao: string;
      }>) {
        const photoId = photosByNomeArquivo.get(result.nome_arquivo);
        if (photoId) {
          await this.prisma.reinspectionPhoto.update({
            where: { id: photoId },
            data: {
              hinovaSituacao: result.situacao,
              sentToHinova: result.situacao === 'Inserido',
            },
          });
        }
      }
    }

    if (response.status >= 400) {
      this.logger.warn(
        `Hinova retornou erro no envio da revistoria aprovada | reinspectionId=${reinspection.id} | status=${response.status} | response=${JSON.stringify(response.data)}`,
      );
    }
  }

  private async readPhotoAsBase64(photoUrl: string | null): Promise<string> {
    if (!photoUrl) {
      throw new BadRequestException(
        'Não foi possível enviar para Hinova: foto sem URL local',
      );
    }

    const filePath = join(process.cwd(), photoUrl);

    try {
      const buffer = await fs.readFile(filePath);
      return buffer.toString('base64');
    } catch {
      throw new InternalServerErrorException(
        `Falha ao ler arquivo local para envio à Hinova: ${photoUrl}`,
      );
    }
  }

  async getRejectedPhotos(userVehicleId: number) {
    const vehicle = await this.prisma.userVehicle.findUnique({
      where: { id: userVehicleId },
      select: { id: true, chassi: true, plate: true },
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

    const rejectedPhotos = await this.prisma.reinspectionPhoto.findMany({
      where: {
        reinspectionId: latestReinspection.id,
        status: ReinspectionPhotoStatus.REPROVADA,
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        url: true,
        templatePhotoId: true,
        templatePhoto: {
          select: {
            id: true,
            photoUrl: true,
            ordem: true,
            vehicleType: true,
          },
        },
      },
    });

    return {
      reinspectionId: latestReinspection.id,
      chassi: vehicle.chassi,
      plate: vehicle.plate,
      reinspectionStatus: latestReinspection.status,
      rejectedPhotos: rejectedPhotos.map((p) => ({
        photoId: p.id,
        photoUrl: this.fileUploadService.buildUrl(p.url),
        templatePhotoId: p.templatePhotoId,
        templatePhotoUrl: this.fileUploadService.buildUrl(
          p.templatePhoto?.photoUrl ?? null,
        ),
        ordem: p.templatePhoto?.ordem ?? null,
        templatePhoto: p.templatePhoto
          ? {
              id: p.templatePhoto.id,
              vehicleType: p.templatePhoto.vehicleType,
              ordem: p.templatePhoto.ordem,
              photoUrl: this.fileUploadService.buildUrl(
                p.templatePhoto.photoUrl,
              ),
            }
          : null,
      })),
    };
  }

  async searchByChassiOrPlate(chassi?: string, plate?: string) {
    const normalizedChassi = chassi?.trim();
    const normalizedPlate = plate?.trim();

    if (!normalizedChassi && !normalizedPlate) {
      throw new BadRequestException(
        'Informe ao menos um parâmetro de busca: chassi ou plate',
      );
    }

    const vehicleFilters = [
      ...(normalizedChassi
        ? [
            {
              userVehicle: {
                chassi: {
                  contains: normalizedChassi,
                },
              },
            },
          ]
        : []),
      ...(normalizedPlate
        ? [
            {
              userVehicle: {
                plate: {
                  contains: normalizedPlate,
                },
              },
            },
          ]
        : []),
    ];

    const reinspections = await this.prisma.reinspection.findMany({
      where: {
        OR: vehicleFilters,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userVehicleId: true,
        vehicleType: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: {
          select: {
            chassi: true,
            plate: true,
          },
        },
        _count: {
          select: {
            photos: true,
          },
        },
      },
    });

    return reinspections.map(({ userVehicle, ...reinspection }) => ({
      ...reinspection,
      chassi: userVehicle.chassi,
      plate: userVehicle.plate,
    }));
  }

  async resendPhoto(photoId: number, base64: string, debugId?: string) {
    const photo = await this.prisma.reinspectionPhoto.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        reinspectionId: true,
        nomeArquivo: true,
        codigoTipo: true,
        status: true,
        reinspection: {
          select: {
            id: true,
            codigoVeiculo: true,
            userVehicle: {
              select: { chassi: true, plate: true },
            },
          },
        },
      },
    });

    if (!photo) {
      throw new NotFoundException('Foto de revistoria não encontrada');
    }

    if (photo.status !== ReinspectionPhotoStatus.REPROVADA) {
      throw new BadRequestException(
        'Somente fotos reprovadas podem ser reenviadas',
      );
    }

    // Faz upload do novo arquivo
    const newUrl =
      await this.fileUploadService.uploadReinspectionPhotoFromBase64(
        base64,
        photo.nomeArquivo,
      );

    // Atualiza a foto e a revistoria em transação
    const [updatedPhoto, updatedReinspection] = await this.prisma.$transaction([
      this.prisma.reinspectionPhoto.update({
        where: { id: photo.id },
        data: {
          url: newUrl,
          status: 'PENDENTE' as unknown as ReinspectionPhotoStatus,
          sentToHinova: false,
          hinovaSituacao: null,
        },
        select: {
          id: true,
          reinspectionId: true,
          nomeArquivo: true,
          codigoTipo: true,
          url: true,
          status: true,
        },
      }),
      this.prisma.reinspection.update({
        where: { id: photo.reinspectionId },
        data: { status: 'EM_ANALISE' },
        select: {
          id: true,
          userVehicleId: true,
          status: true,
          codigoVeiculo: true,
        },
      }),
    ]);

    // Envia e-mail com assunto específico
    try {
      await this.mailService.sendFotoRecusadaReenviadaEmail(
        photo.reinspection.userVehicle.chassi,
        photo.reinspection.userVehicle.plate,
        debugId,
        [newUrl],
      );
    } catch (emailError) {
      this.error(debugId, 'Falha ao enviar e-mail de foto reenviada', {
        photoId,
        error:
          emailError instanceof Error ? emailError.message : String(emailError),
      });
    }

    return {
      photoId: updatedPhoto.id,
      reinspectionId: updatedReinspection.id,
      reinspectionStatus: updatedReinspection.status,
      photoStatus: updatedPhoto.status,
      photoUrl: this.fileUploadService.buildUrl(updatedPhoto.url),
    };
  }

  async reprovePhoto(photoId: number) {
    const photo = await this.prisma.reinspectionPhoto.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        reinspectionId: true,
        templatePhotoId: true,
        nomeArquivo: true,
        reinspection: {
          select: {
            vehicleType: true,
          },
        },
      },
    });

    if (!photo) {
      throw new NotFoundException('Foto de revistoria não encontrada');
    }

    const templatePhotoIdToUse = await this.resolveTemplatePhotoIdForReprove(
      photo.templatePhotoId,
      photo.nomeArquivo,
      photo.reinspection.vehicleType,
    );

    const [updatedPhoto, updatedReinspection] = await this.prisma.$transaction([
      this.prisma.reinspectionPhoto.update({
        where: { id: photo.id },
        data: {
          status: ReinspectionPhotoStatus.REPROVADA,
          templatePhotoId: templatePhotoIdToUse,
        },
        select: {
          id: true,
          reinspectionId: true,
          nomeArquivo: true,
          templatePhotoId: true,
          status: true,
        },
      }),
      this.prisma.reinspection.update({
        where: { id: photo.reinspectionId },
        data: {
          status: 'REPROVADA',
        },
        select: {
          id: true,
          userVehicleId: true,
          status: true,
          updatedAt: true,
        },
      }),
    ]);

    this.logger.warn(
      `Foto reprovada e revistoria atualizada para REPROVADA | photoId=${updatedPhoto.id} | reinspectionId=${updatedReinspection.id} | templatePhotoId=${updatedPhoto.templatePhotoId ?? 'N/A'}`,
    );

    return {
      photo: updatedPhoto,
      reinspection: {
        reinspectionId: updatedReinspection.id,
        userVehicleId: updatedReinspection.userVehicleId,
        status: updatedReinspection.status,
        updatedAt: updatedReinspection.updatedAt,
      },
    };
  }

  async approvePhoto(photoId: number) {
    const photo = await this.prisma.reinspectionPhoto.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        reinspectionId: true,
      },
    });

    if (!photo) {
      throw new NotFoundException('Foto de revistoria não encontrada');
    }

    const [updatedPhoto, hasRejectedPhoto] = await this.prisma.$transaction([
      this.prisma.reinspectionPhoto.update({
        where: { id: photo.id },
        data: {
          status: ReinspectionPhotoStatus.APROVADA,
        },
        select: {
          id: true,
          reinspectionId: true,
          nomeArquivo: true,
          templatePhotoId: true,
          status: true,
        },
      }),
      this.prisma.reinspectionPhoto.findFirst({
        where: {
          reinspectionId: photo.reinspectionId,
          status: ReinspectionPhotoStatus.REPROVADA,
          NOT: { id: photo.id },
        },
        select: { id: true },
      }),
    ]);

    const reinspectionStatus = hasRejectedPhoto ? 'REPROVADA' : 'EM_ANALISE';

    const updatedReinspection = await this.prisma.reinspection.update({
      where: { id: photo.reinspectionId },
      data: { status: reinspectionStatus },
      select: {
        id: true,
        userVehicleId: true,
        status: true,
        updatedAt: true,
      },
    });

    return {
      photo: updatedPhoto,
      reinspection: {
        reinspectionId: updatedReinspection.id,
        userVehicleId: updatedReinspection.userVehicleId,
        status: updatedReinspection.status,
        updatedAt: updatedReinspection.updatedAt,
      },
    };
  }

  private async resolveTemplatePhotoIdForReprove(
    currentTemplatePhotoId: number | null,
    nomeArquivo: string,
    vehicleType: ReinspectionVehicleType,
  ): Promise<number | null> {
    if (currentTemplatePhotoId != null) {
      return currentTemplatePhotoId;
    }

    const ordem = this.extractOrdemFromNomeArquivo(nomeArquivo);
    if (ordem == null) {
      this.logger.warn(
        `Não foi possível inferir templatePhotoId: ordem ausente no nome do arquivo | nomeArquivo=${nomeArquivo}`,
      );
      return null;
    }

    const templatePhoto =
      await this.prisma.reinspectionTemplatePhoto.findUnique({
        where: {
          vehicleType_ordem: {
            vehicleType,
            ordem,
          },
        },
        select: { id: true },
      });

    if (!templatePhoto) {
      this.logger.warn(
        `Não foi possível inferir templatePhotoId: template não encontrado | vehicleType=${vehicleType} | ordem=${ordem}`,
      );
      return null;
    }

    return templatePhoto.id;
  }

  private extractOrdemFromNomeArquivo(nomeArquivo: string): number | null {
    const match = nomeArquivo.match(/ordem[_-]?(\d+)/i);
    if (!match) {
      return null;
    }

    const ordem = Number.parseInt(match[1], 10);
    return Number.isNaN(ordem) ? null : ordem;
  }
}

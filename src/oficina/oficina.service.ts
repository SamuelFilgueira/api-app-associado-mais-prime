import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { workshop } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { FileUploadService } from '../common/services/file-upload.service';
import { CreateWorkshopDto } from './DTOs/create-workshop.dto';
import { UpdateWorkshopDto } from './DTOs/update-workshop.dto';

type WorkshopImageFiles = {
  photoFront?: Express.Multer.File;
  photoBack?: Express.Multer.File;
};

type WorkshopResponse = Omit<workshop, 'services'> & {
  services: string[];
  photoFrontUrl: string | null;
  photoBackUrl: string | null;
};

type WorkshopWithDistance = workshop & { distance: number };
type WorkshopWithDistanceResponse = Omit<WorkshopWithDistance, 'services'> & {
  services: string[];
  photoFrontUrl: string | null;
  photoBackUrl: string | null;
};

@Injectable()
export class OficinaService {
  private readonly logger = new Logger(OficinaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileUploadService: FileUploadService,
  ) {}

  // Criação de oficina com busca opcional do CEP
  async createWorkshop(data: CreateWorkshopDto, files?: WorkshopImageFiles) {
    if (!data || typeof data !== 'object') {
      throw new BadRequestException('Dados da oficina são obrigatórios');
    }

    // Verificar nome duplicado
    const existing = await this.prisma.workshop.findFirst({
      where: { name: data.name },
    });

    if (existing) {
      throw new BadRequestException(
        'Já existe uma oficina cadastrada com este nome',
      );
    }

    const payload: CreateWorkshopDto & {
      latitude?: number;
      longitude?: number;
    } = { ...data };

    // Normalizar telefones com prefixo +55
    this.normalizePhoneNumbers(payload);

    if (Array.isArray(payload.services)) {
      payload.services = this.normalizeServices(payload.services);
    }

    if (files?.photoFront) {
      const photoUrl = await this.fileUploadService.uploadWorkshopPhoto(
        files.photoFront,
        'front',
      );
      payload.photoFrontUrl = photoUrl;
    }

    if (files?.photoBack) {
      const photoUrl = await this.fileUploadService.uploadWorkshopPhoto(
        files.photoBack,
        'back',
      );
      payload.photoBackUrl = photoUrl;
    }

    // Se vier CEP → tentar buscar coordenadas
    if (payload.cep) {
      const coords = await this.lookupCepCoordinates(payload.cep);
      if (coords.latitude != null && coords.longitude != null) {
        payload.latitude = coords.latitude;
        payload.longitude = coords.longitude;
      }
    }

    return this.prisma.workshop.create({ data: payload });
  }

  // Atualização de oficina
  async updateWorkshop(
    id: number,
    data: UpdateWorkshopDto,
    files?: WorkshopImageFiles,
  ) {
    const workshopId = Number(id);

    // Validação de ID
    if (isNaN(workshopId) || workshopId <= 0) {
      throw new BadRequestException('ID da oficina deve ser um número válido');
    }

    if (!data || typeof data !== 'object') {
      throw new BadRequestException('Dados para atualização são obrigatórios');
    }

    const existing = await this.prisma.workshop.findUnique({
      where: { id: workshopId },
    });

    if (!existing) {
      throw new NotFoundException('Oficina não encontrada');
    }

    // Verificar duplicidade de nome caso tenha alteração
    if (data.name && data.name !== existing.name) {
      const duplicateName = await this.prisma.workshop.findFirst({
        where: {
          name: data.name,
          id: { not: workshopId }, // 👈 EXCLUI O PRÓPRIO REGISTRO
        },
      });

      if (duplicateName) {
        throw new BadRequestException(
          'Já existe uma oficina cadastrada com este nome',
        );
      }
    }

    const payload: Omit<UpdateWorkshopDto, 'id'> & {
      latitude?: number;
      longitude?: number;
    } = { ...data };

    // Normalizar telefones com prefixo +55
    this.normalizePhoneNumbers(payload);

    if (Array.isArray(payload.services)) {
      payload.services = this.normalizeServices(payload.services);
    }

    if (files?.photoFront) {
      if (existing.photoFrontUrl) {
        await this.fileUploadService.deleteWorkshopPhoto(
          existing.photoFrontUrl,
        );
      }

      const photoUrl = await this.fileUploadService.uploadWorkshopPhoto(
        files.photoFront,
        'front',
      );
      payload.photoFrontUrl = photoUrl;
    }

    if (files?.photoBack) {
      if (existing.photoBackUrl) {
        await this.fileUploadService.deleteWorkshopPhoto(existing.photoBackUrl);
      }

      const photoUrl = await this.fileUploadService.uploadWorkshopPhoto(
        files.photoBack,
        'back',
      );
      payload.photoBackUrl = photoUrl;
    }

    // Buscar coordenadas se CEP foi enviado
    if (payload.cep) {
      const coords = await this.lookupCepCoordinates(payload.cep);
      if (coords.latitude != null && coords.longitude != null) {
        payload.latitude = coords.latitude;
        payload.longitude = coords.longitude;
      }
    }

    return this.prisma.workshop.update({
      where: { id: workshopId },
      data: payload,
    });
  }

  async removeWorkshop(id: number): Promise<{ deleted: true }> {
    const workshopId = Number(id);

    if (isNaN(workshopId) || workshopId <= 0) {
      throw new BadRequestException('ID da oficina deve ser um número válido');
    }

    const existing = await this.prisma.workshop.findUnique({
      where: { id: workshopId },
    });

    if (!existing) {
      throw new NotFoundException('Oficina não encontrada');
    }

    if (existing.photoFrontUrl) {
      await this.fileUploadService.deleteWorkshopPhoto(existing.photoFrontUrl);
    }

    if (existing.photoBackUrl) {
      await this.fileUploadService.deleteWorkshopPhoto(existing.photoBackUrl);
    }

    await this.prisma.workshop.delete({ where: { id: workshopId } });
    return { deleted: true };
  }

  //Retorna todas as oficinas com paginação
  async findAllWorkshops(
    page = 1,
    limit = 10,
  ): Promise<{
    data: WorkshopResponse[];
    total: number;
    page: number;
    limit: number;
    pageCount: number;
  }> {
    const take = limit > 0 ? limit : 10;
    const skip = page > 1 ? (page - 1) * take : 0;
    const [data, total] = await Promise.all([
      this.prisma.workshop.findMany({
        orderBy: { name: 'asc' },
        skip,
        take,
      }),
      this.prisma.workshop.count(),
    ]);
    return {
      data: data.map((workshop) => this.formatWorkshop(workshop)),
      total,
      page,
      limit: take,
      pageCount: Math.ceil(total / take),
    };
  }

  // Buscar oficinas próximas pela localização do usuário
  async findNearbyWorkshops(
    latitude: number,
    longitude: number,
    radiusKm = 10,
  ): Promise<WorkshopWithDistanceResponse[]> {
    if (!latitude || !longitude) {
      throw new BadRequestException('Latitude e longitude são obrigatórias');
    }

    const workshops = await this.prisma.$queryRaw<WorkshopWithDistance[]>`
    SELECT *, 
      (
        6371 * acos(
          cos(radians(${latitude}))
          * cos(radians(latitude))
          * cos(radians(longitude) - radians(${longitude}))
          + sin(radians(${latitude})) 
          * sin(radians(latitude))
        )
      ) AS distance
    FROM workshop
    WHERE latitude IS NOT NULL
      AND longitude IS NOT NULL
    HAVING distance < ${radiusKm}
    ORDER BY distance ASC;
  `;

    return workshops.map((workshop) =>
      this.formatWorkshopWithDistance(workshop),
    );
  }

  private formatWorkshop(workshop: workshop): WorkshopResponse {
    return {
      ...workshop,
      services: this.normalizeServices(workshop.services),
      photoFrontUrl: workshop.photoFrontUrl ?? null,
      photoBackUrl: workshop.photoBackUrl ?? null,
    };
  }

  private formatWorkshopWithDistance(
    workshop: WorkshopWithDistance,
  ): WorkshopWithDistanceResponse {
    return {
      ...workshop,
      services: this.normalizeServices(workshop.services),
      photoFrontUrl: workshop.photoFrontUrl ?? null,
      photoBackUrl: workshop.photoBackUrl ?? null,
    };
  }

  private normalizeServices(services: unknown): string[] {
    if (!Array.isArray(services)) return [];

    return services
      .filter((service): service is string => typeof service === 'string')
      .map((service) => service.trim())
      .filter((service) => service.length > 0);
  }

  /**
   * Normaliza números de telefone adicionando prefixo +55 quando ausente
   */
  private normalizePhoneNumbers(payload: {
    phone?: string;
    phoneSecondary?: string;
    whatsapp?: string;
  }): void {
    if (payload.phone && !payload.phone.startsWith('+55')) {
      payload.phone = `+55${payload.phone.replace(/^\+?55/, '')}`;
    }
    if (payload.phoneSecondary && !payload.phoneSecondary.startsWith('+55')) {
      payload.phoneSecondary = `+55${payload.phoneSecondary.replace(/^\+?55/, '')}`;
    }
    if (payload.whatsapp && !payload.whatsapp.startsWith('+55')) {
      payload.whatsapp = `+55${payload.whatsapp.replace(/^\+?55/, '')}`;
    }
  }

  /**
   * Busca coordenadas geográficas a partir de um CEP via API CepAberto
   */
  private async lookupCepCoordinates(
    cep: string,
  ): Promise<{ latitude?: number; longitude?: number }> {
    try {
      const token =
        process.env.CEPABERTO_TOKEN || process.env.CEPABERTO_API_TOKEN;

      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Token token=${token}`;
      }

      const resp = await axios.get('https://www.cepaberto.com/api/v3/cep', {
        params: { cep },
        headers,
        timeout: 5000,
      });

      const body = resp.data || {};
      const lat = body.latitude ?? body.lat;
      const lon = body.longitude ?? body.lng ?? body.lon;

      if (lat != null && lon != null) {
        return { latitude: Number(lat), longitude: Number(lon) };
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Erro ao buscar coordenadas no cepaberto para CEP ${cep}: ${errorMessage}`,
      );
    }
    return {};
  }
}

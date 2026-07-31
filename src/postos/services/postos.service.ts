import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';
import { BaseOrigin } from 'src/config/tenant.config';

@Injectable()
export class PostosService {
  private readonly logger = new Logger(PostosService.name);

  constructor(
    private prisma: PrismaService,
    private readonly clubgasClient: ClubgasClient,
  ) {}

  async buscarPostos(
    latitude: number,
    longitude: number,
    userId: number,
    chassi: string,
    page: number = 1,
    baseOrigin: BaseOrigin,
  ) {
    const vehicle = await this.prisma.userVehicle.findFirst({
      where: {
        userId,
        chassi,
        isActive: true,
      },
    });

    if (!vehicle?.plate) {
      this.logger.warn(`Placa não encontrada para userId: ${userId}`);
      throw new NotFoundException('Placa não encontrada para o usuário');
    }

    let data: Awaited<ReturnType<ClubgasClient['obterPostosMapa']>>;
    try {
      data = await this.clubgasClient.obterPostosMapa(baseOrigin, {
        latitude,
        longitude,
        placa: vehicle.plate,
      });
    } catch (error: unknown) {
      const axiosError = error as {
        message?: string;
        response?: { data?: unknown };
      };
      this.logger.error(
        `Erro ao chamar API de postos: ${axiosError.message ?? 'erro desconhecido'}`,
        axiosError.response?.data,
      );
      throw error;
    }
    // Paginação local
    const pageSize = 5;
    const totalElements = data.result.length;
    const totalPages = Math.ceil(totalElements / pageSize);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const paginatedResult = data.result.slice(start, end);
    return {
      pagination: {
        totalElements,
        pageSize,
        pageNumber: page,
        totalPages,
      },
      result: paginatedResult,
    };
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

type ClubgasPostosResponse = {
  result: unknown[];
};

@Injectable()
export class PostosService {
  private readonly logger = new Logger(PostosService.name);

  constructor(private prisma: PrismaService) {}

  private maskSecret(value?: string): string {
    if (!value) return '(vazio)';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  async buscarPostos(
    latitude: number,
    longitude: number,
    userId: number,
    chassi: string,
    page: number = 1,
    clubgasToken: string,
    baseOrigin?: string,
    clubgasTokenKey?: string,
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

    const url = `https://clubgas-api.azurewebsites.net/api/v1/Posto/obter-map-app?Latitude=${latitude}&Longitude=${longitude}&Placa=${vehicle.plate}`;
    this.logger.log(`URL chamada para API de postos: ${url}`);
    this.logger.log(
      `[${baseOrigin ?? 'DESCONHECIDA'}] ClubGas postos usando tokenKey=${clubgasTokenKey ?? '(não informado)'} token=${this.maskSecret(clubgasToken)}`,
    );

    let data: ClubgasPostosResponse;
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${clubgasToken}`,
        },
      });
      data = response.data;
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

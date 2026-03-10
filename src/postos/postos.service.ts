import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma.service';

@Injectable()
export class PostosService {
  private readonly logger = new Logger(PostosService.name);

  constructor(private prisma: PrismaService) {}

  async buscarPostos(
    latitude: number,
    longitude: number,
    userId: number,
    page: number = 1,
  ) {
    const vehicle = await this.prisma.userVehicle.findFirst({
      where: { userId, isActive: true, plate: { not: null } },
    });

    if (!vehicle?.plate) {
      this.logger.warn(`Placa não encontrada para userId: ${userId}`);
      throw new NotFoundException('Placa não encontrada para o usuário');
    }

    const url = `https://clubgas-api.azurewebsites.net/api/v1/Posto/obter-map-app?Latitude=${latitude}&Longitude=${longitude}&Placa=${vehicle.plate}`;
    this.logger.log(`URL chamada para API de postos: ${url}`);
    this.logger.log(
      `TOKEN_API_CLUBGAS definido: ${!!process.env.TOKEN_API_CLUBGAS}`,
    );

    let data: any;
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.TOKEN_API_CLUBGAS}`,
        },
      });
      data = response.data;
    } catch (error) {
      this.logger.error(
        `Erro ao chamar API de postos: ${error?.message}`,
        error?.response?.data,
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

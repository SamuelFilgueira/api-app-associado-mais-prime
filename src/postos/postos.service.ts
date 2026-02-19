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
    this.logger.log(`buscarPostos chamado com: ${JSON.stringify({ latitude, longitude, userId, page })}`);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.plate) {
      throw new NotFoundException('Placa não encontrada para o usuário');
    }

    const url = `https://tst-clubgas-api.azurewebsites.net/api/v1/Posto/obter-map-app?Latitude=${latitude}&Longitude=${longitude}&Placa=${user.plate}`;
    const { data } = await axios.get(url);

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

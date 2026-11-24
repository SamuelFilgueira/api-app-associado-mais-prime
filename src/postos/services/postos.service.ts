import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';
import { BaseOrigin } from 'src/config/tenant.config';
import { baseTag } from 'src/shared/log.util';

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

    const tag = `${baseTag(baseOrigin)} [postos]`;
    this.logger.log(
      `${tag} requisição: userId=${userId} chassi=${chassi} placa=${vehicle.plate} ` +
        `lat=${latitude} lng=${longitude} página=${page}/${totalPages} ` +
        `(itens ${start + 1}-${Math.min(end, totalElements)} de ${totalElements})`,
    );
    this.logger.log(
      `${tag} lista completa do Clubgas (${totalElements} postos, ${pageSize} por página):\n` +
        data.result
          .map((posto, i) =>
            this.descreverPosto(posto, i, pageSize, i >= start && i < end),
          )
          .join('\n'),
    );
    if (paginatedResult.length === 0) {
      this.logger.warn(
        `${tag} página ${page} vazia — fora do intervalo 1-${totalPages}`,
      );
    }

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

  /**
   * Linha de log de um posto: posição na lista do Clubgas, página em que cai
   * na paginação local e os campos que identificam o posto. `>>` marca os
   * postos devolvidos nesta requisição.
   */
  private descreverPosto(
    posto: unknown,
    indice: number,
    pageSize: number,
    naPaginaAtual: boolean,
  ): string {
    const p = (posto ?? {}) as Record<string, string | number | undefined>;
    const marcador = naPaginaAtual ? '>>' : '  ';
    const pagina = Math.floor(indice / pageSize) + 1;
    return (
      `${marcador} #${indice + 1} pág.${pagina} | ${p.postoNome ?? '(sem nome)'} | ` +
      `${p.enderecoPosto ?? '(sem endereço)'} | ${p.distancia ?? '?'} km | ` +
      `lat=${p.latitude ?? '?'} lng=${p.longitude ?? '?'} | id=${p.id ?? '?'}`
    );
  }
}

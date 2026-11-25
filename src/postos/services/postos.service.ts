import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import {
  ClubgasClient,
  postosRecusadosPelaPlaca,
} from 'src/integrations/clubgas/clubgas.client';
import { ClubgasErro } from 'src/integrations/clubgas/clubgas.erro';
import {
  ClubgasErroContexto,
  ClubgasErroLogService,
} from 'src/integrations/clubgas/clubgas-erro-log.service';
import { BaseOrigin } from 'src/config/tenant.config';
import { baseTag } from 'src/shared/log.util';

@Injectable()
export class PostosService {
  private readonly logger = new Logger(PostosService.name);

  constructor(
    private prisma: PrismaService,
    private readonly clubgasClient: ClubgasClient,
    private readonly clubgasErros: ClubgasErroLogService,
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

    const contexto: ClubgasErroContexto = {
      userId,
      baseOrigin,
      chassi,
      placa: vehicle?.plate ?? null,
    };

    if (!vehicle?.plate) {
      throw await this.clubgasErros.tratar(
        new ClubgasErro({
          operacao: 'POSTOS',
          categoria: 'VEICULO_SEM_PLACA',
          mensagem: 'Placa não encontrada para o usuário',
        }),
        contexto,
      );
    }

    let data: Awaited<ReturnType<ClubgasClient['obterPostosMapa']>>;
    try {
      data = await this.clubgasClient.obterPostosMapa(baseOrigin, {
        latitude,
        longitude,
        placa: vehicle.plate,
      });
    } catch (falha) {
      // Grava em ClubgasErroLog e devolve ao app a mensagem do Clubgas.
      throw await this.clubgasErros.tratar(falha, contexto);
    }

    // Placa fora do formato aceito: o Clubgas não devolve erro, só uma lista
    // vazia. A resposta ao app continua a mesma; a ocorrência fica registrada.
    if (postosRecusadosPelaPlaca(data)) {
      await this.clubgasErros.registrar(
        new ClubgasErro({
          operacao: 'POSTOS',
          categoria: 'PLACA_INVALIDA',
          mensagem:
            'Clubgas devolveu a lista de postos vazia e sem paginação (placa fora do formato aceito)',
          httpStatus: 200,
          resposta: data,
        }),
        contexto,
      );
    }

    // Paginação local
    const postos = Array.isArray(data.result) ? data.result : [];
    const pageSize = 5;
    const totalElements = postos.length;
    const totalPages = Math.ceil(totalElements / pageSize);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const paginatedResult = postos.slice(start, end);

    const tag = `${baseTag(baseOrigin)} [postos]`;
    this.logger.log(
      `${tag} requisição: userId=${userId} chassi=${chassi} placa=${vehicle.plate} ` +
        `lat=${latitude} lng=${longitude} página=${page}/${totalPages} ` +
        `(itens ${start + 1}-${Math.min(end, totalElements)} de ${totalElements})`,
    );
    this.logger.log(
      `${tag} lista completa do Clubgas (${totalElements} postos, ${pageSize} por página):\n` +
        postos
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

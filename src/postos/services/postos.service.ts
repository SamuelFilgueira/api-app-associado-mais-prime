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
import { CacheService } from 'src/infra/cache/cache.service';
import {
  TTL_DO_CACHE_DE_POSTOS_SEG,
  chaveDoCacheDePostos,
  descreverPosto,
  paginarPostos,
} from 'src/postos/domain/busca-de-postos';
import { baseTag } from 'src/shared/log.util';

@Injectable()
export class PostosService {
  private readonly logger = new Logger(PostosService.name);

  constructor(
    private prisma: PrismaService,
    private readonly clubgasClient: ClubgasClient,
    private readonly clubgasErros: ClubgasErroLogService,
    private readonly cache: CacheService,
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

    // A lista inteira vem do Clubgas de uma vez e a paginação é local: as
    // páginas seguintes da mesma busca saem do cache, por base. Só resposta
    // válida é guardada — recusa pela placa e erro voltam ao Clubgas sempre.
    const busca = { latitude, longitude, placa: vehicle.plate };
    let data: Awaited<ReturnType<ClubgasClient['obterPostosMapa']>>;
    let fonte: string;
    try {
      ({ valor: data, fonte } = await this.cache.obter({
        base: baseOrigin,
        chave: chaveDoCacheDePostos(busca),
        recurso: 'clubgas_postos',
        ttlSeg: TTL_DO_CACHE_DE_POSTOS_SEG,
        carregar: () => this.clubgasClient.obterPostosMapa(baseOrigin, busca),
        guardarSe: (resposta) =>
          Array.isArray(resposta?.result) &&
          !postosRecusadosPelaPlaca(resposta),
      }));
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

    // Paginação local, sobre a lista completa (do Clubgas ou do cache).
    const postos = Array.isArray(data.result) ? data.result : [];
    const {
      pagination,
      result: paginatedResult,
      inicio: start,
      fim: end,
    } = paginarPostos(postos, page);
    const { totalElements, pageSize, totalPages } = pagination;

    const tag = `${baseTag(baseOrigin)} [postos]`;
    this.logger.log(
      `${tag} requisição: userId=${userId} chassi=${chassi} placa=${vehicle.plate} ` +
        `lat=${latitude} lng=${longitude} página=${page}/${totalPages} ` +
        `(itens ${start + 1}-${Math.min(end, totalElements)} de ${totalElements})`,
    );
    this.logger.log(
      `${tag} lista completa do Clubgas (${totalElements} postos, ${pageSize} por página, fonte: ${fonte}):\n` +
        postos
          .map((posto, i) =>
            descreverPosto(posto, i, pageSize, i >= start && i < end),
          )
          .join('\n'),
    );
    if (paginatedResult.length === 0) {
      this.logger.warn(
        `${tag} página ${page} vazia — fora do intervalo 1-${totalPages}`,
      );
    }

    return { pagination, result: paginatedResult };
  }
}

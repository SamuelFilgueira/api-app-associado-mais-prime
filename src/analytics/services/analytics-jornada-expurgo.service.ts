import { Injectable, Logger } from '@nestjs/common';
import { jornadaAnalyticsTtlDias } from 'src/config/retencao.config';
import { PrismaService } from 'src/database/prisma.service';

/** Lote de DELETE por comando — evita lock longo na tabela. */
const LOTE = 5000;
/** Teto de lotes por rodada (o resto fica para a rodada seguinte). */
const MAX_LOTES = 200;

const DIA_MS = 24 * 60 * 60 * 1000;

export interface ResultadoDoExpurgoDaJornada {
  /** Eventos apagados nesta rodada. */
  removidos: number;
  /** Eventos anteriores a este instante foram apagados. */
  corte: Date;
  ttlDias: number;
  /** `true` quando a rodada parou no teto de lotes e ainda há o que apagar. */
  incompleto: boolean;
}

/**
 * Expurgo dos eventos de jornada (`AnalyticsJourneyEvent`) mais antigos que
 * `ANALYTICS_JOURNEY_TTL_DAYS` (padrão: 90 dias).
 *
 * Aparelhos e vínculos conta↔aparelho NÃO são apagados — são a memória de
 * "quais celulares já usaram a conta".
 *
 * Hoje é disparado pelo job `journey-cleanup` na fila de analytics; o método
 * é público e sem estado para poder ser chamado pela rotina de manutenção.
 */
@Injectable()
export class AnalyticsJornadaExpurgoService {
  private readonly logger = new Logger(AnalyticsJornadaExpurgoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Apaga em lotes pequenos (`DELETE ... LIMIT`), para não segurar lock na
   * tabela. Seguro para repetir e para rodar em paralelo com a ingestão.
   */
  async expurgarJornada(
    agora: Date = new Date(),
  ): Promise<ResultadoDoExpurgoDaJornada> {
    const ttlDias = jornadaAnalyticsTtlDias();
    const corte = new Date(agora.getTime() - ttlDias * DIA_MS);

    let removidos = 0;
    let incompleto = true;
    for (let lote = 0; lote < MAX_LOTES; lote++) {
      const apagados = await this.prisma.$executeRaw`
        DELETE FROM \`AnalyticsJourneyEvent\`
        WHERE \`occurredAt\` < ${corte}
        LIMIT ${LOTE}
      `;
      removidos += apagados;
      if (apagados < LOTE) {
        incompleto = false;
        break;
      }
    }

    if (removidos > 0) {
      this.logger.log(
        `Limpeza da jornada: ${removidos} evento(s) anteriores a ${corte.toISOString()} removidos (TTL ${ttlDias}d)` +
          (incompleto
            ? ' — teto de lotes atingido, o resto fica para a próxima rodada'
            : ''),
      );
    }
    return { removidos, corte, ttlDias, incompleto };
  }
}

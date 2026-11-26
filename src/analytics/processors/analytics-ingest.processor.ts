import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JOURNEY_CLEANUP_JOB } from 'src/analytics/constants/analytics-journey.constants';
import {
  DadosDoResumo,
  JornadaDoResumo,
} from 'src/analytics/domain/agregados-diarios';
import { AnalyticsAplicarResumoService } from 'src/analytics/services/analytics-aplicar-resumo.service';
import {
  AnalyticsJornadaExpurgoService,
  ResultadoDoExpurgoDaJornada,
} from 'src/analytics/services/analytics-jornada-expurgo.service';
import { metricas } from 'src/infra/observability/metricas';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProcessadorBase } from 'src/queue/processador-base';
import { ANALYTICS_QUEUE } from 'src/queue/queue.module';

/** Payload do job `process-summary`. */
export type AnalyticsSummaryJobData = DadosDoResumo;
export type AnalyticsJourneyJobData = JornadaDoResumo;

export type ResultadoDoJobDeAnalytics =
  | { resultado: 'aplicado' | 'descartado' }
  | ResultadoDoExpurgoDaJornada;

/**
 * Worker da fila de analytics. Só delega:
 *  - `process-summary` → `AnalyticsAplicarResumoService` (agregados diários,
 *    recibo e jornada, numa transação);
 *  - `journey-cleanup` → `AnalyticsJornadaExpurgoService`.
 *
 * Reentrega do mesmo summary não soma de novo: conclui como `descartado`.
 */
@Processor(ANALYTICS_QUEUE)
export class AnalyticsIngestProcessor extends ProcessadorBase<
  AnalyticsSummaryJobData,
  ResultadoDoJobDeAnalytics
> {
  protected readonly logger = new Logger(AnalyticsIngestProcessor.name);

  constructor(
    private readonly aplicarResumo: AnalyticsAplicarResumoService,
    private readonly expurgo: AnalyticsJornadaExpurgoService,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  protected async executar(
    job: Job<AnalyticsSummaryJobData>,
  ): Promise<ResultadoDoJobDeAnalytics> {
    if (job.name === JOURNEY_CLEANUP_JOB) {
      return this.expurgo.expurgarJornada();
    }

    let resultado: Awaited<
      ReturnType<AnalyticsAplicarResumoService['aplicar']>
    >;
    try {
      resultado = await this.aplicarResumo.aplicar(job.data);
    } catch (err) {
      this.logger.error(
        `Falha ao processar analytics job ${job.id}: ${(err as Error).message}`,
      );
      throw err; // BullMQ vai retentar conforme configuração
    }

    if (resultado === 'DESCARTADO') {
      // Summary repetido (retry de rede do app ou reentrega do job): o
      // recibo já existe e os agregados não são tocados.
      metricas.filaProcessados.inc({
        queue: job.queueName,
        name: job.name,
        resultado: 'descartado',
      });
      this.logger.log(
        `Summary repetido descartado (job ${job.id}, payloadHash ${job.data.payloadHash})`,
      );
      return { resultado: 'descartado' };
    }
    return { resultado: 'aplicado' };
  }
}

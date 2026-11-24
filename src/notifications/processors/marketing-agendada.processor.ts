import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  MarketingAgendadaJobData,
  MarketingAgendamentoService,
} from 'src/notifications/services/marketing-agendamento.service';
import { MARKETING_AGENDADA_QUEUE } from 'src/queue/queue.module';

/**
 * Dispara os pushes de marketing agendados. Concorrência 1: dois disparos em
 * massa não rodam ao mesmo tempo. Só delega; a regra fica no service.
 */
@Processor(MARKETING_AGENDADA_QUEUE, { concurrency: 1 })
export class MarketingAgendadaProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(MarketingAgendadaProcessor.name);

  constructor(private readonly agendamento: MarketingAgendamentoService) {
    super();
  }

  /** Recria jobs de agendamentos pendentes. Nunca derruba o boot. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const r = await this.agendamento.reconciliarPendentes();
      if (r.agendados || r.perdidos || r.interrompidos) {
        this.logger.log(
          `Disparos agendados: ${r.agendados} aguardando, ${r.perdidos} com horário perdido, ${r.interrompidos} interrompidos`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Falha ao reconciliar disparos agendados: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async process(job: Job<MarketingAgendadaJobData>): Promise<void> {
    await this.agendamento.executar(Number(job.data.auditId));
  }
}

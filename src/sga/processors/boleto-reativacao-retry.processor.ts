import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import { BOLETO_REATIVACAO_RETRY_QUEUE } from 'src/queue/queue.module';
import {
  BoletoReativacaoRetryJobData,
  BoletoReativacaoService,
} from 'src/sga/services/boleto-reativacao.service';

/**
 * Retry da criação do boleto de reativação. Cada job é uma tentativa única:
 * o próprio `BoletoReativacaoService.processar` decide se agenda a próxima
 * (instabilidade dentro da janela) ou encerra (`GERADO`/`FALHA`). Sem
 * `attempts`/`backoff` do BullMQ para não criar uma segunda cadência.
 */
@Processor(BOLETO_REATIVACAO_RETRY_QUEUE as string)
export class BoletoReativacaoRetryProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(BoletoReativacaoRetryProcessor.name);

  constructor(private readonly boletoReativacao: BoletoReativacaoService) {
    super();
  }

  /** Reagenda pendentes que ficaram sem job (reinício/Redis limpo). Nunca derruba o boot. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const { pendentes, agendados } =
        await this.boletoReativacao.reconciliarPendentes();
      this.logger.log(
        `Boletos de reativação aguardando retry: ${pendentes}; jobs garantidos: ${agendados}`,
      );
    } catch (error) {
      this.logger.error(
        `Falha ao reconciliar retries de boleto de reativação: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async process(job: Job<BoletoReativacaoRetryJobData>): Promise<void> {
    const { reinspectionId, debugId } = job.data;
    try {
      await this.boletoReativacao.processar(reinspectionId, {
        origem: 'RETRY',
        debugId,
      });
    } catch (error) {
      // Só revistoria inexistente chega aqui; o service trata o resto.
      this.logger.error(
        `Retry de boleto abortado para revistoria ${reinspectionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

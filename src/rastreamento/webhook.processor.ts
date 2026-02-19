import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WEBHOOK_QUEUE } from '../queue/queue.module';
import { RastreamentoService } from './rastreamento.service';

/**
 * Processor que consome jobs da fila de webhooks.
 *
 * Cada job contém o payload bruto recebido pelo endpoint de webhook M7.
 * O processamento assíncrono garante que:
 *   1. O endpoint responde imediatamente (HTTP 200) ao provedor de rastreamento.
 *   2. Os passos pesados (I/O no disco, persistência no DB) acontecem em background.
 *   3. Em caso de falha, o BullMQ faz retry automático com backoff exponencial.
 */
@Processor(WEBHOOK_QUEUE)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly rastreamentoService: RastreamentoService) {
    super();
  }

  async process(job: Job<{ payload: unknown }>): Promise<any> {
    this.logger.log(
      `Processando webhook job #${job.id} (attempt ${job.attemptsMade + 1})`,
    );

    try {
      const result = await this.rastreamentoService.processarWebhookM7(
        job.data.payload,
      );
      this.logger.log(`Webhook job #${job.id} concluído com sucesso`);
      return result;
    } catch (error) {
      this.logger.error(
        `Webhook job #${job.id} falhou: ${error instanceof Error ? error.message : error}`,
      );
      throw error; // BullMQ fará retry conforme configuração
    }
  }
}

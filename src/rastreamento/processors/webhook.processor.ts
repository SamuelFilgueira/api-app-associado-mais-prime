import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProcessadorBase } from 'src/queue/processador-base';
import { WEBHOOK_QUEUE } from 'src/queue/queue.module';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';

/**
 * Eventos de veículo são independentes entre si e o trabalho é quase todo
 * espera de I/O (banco e Expo): vários ao mesmo tempo, para uma rajada da M7
 * não formar fila atrás de um push lento.
 */
export const CONCORRENCIA_DO_WEBHOOK = 8;

/**
 * Processor que consome jobs da fila de webhooks.
 *
 * Cada job contém o payload bruto recebido pelo endpoint de webhook M7:
 *   1. o endpoint responde imediatamente ao provedor de rastreamento;
 *   2. gravação e push acontecem aqui, em segundo plano;
 *   3. qualquer falha (banco, push) faz o job falhar e ser repetido com o
 *      retry padrão da fila — o tratamento é idempotente pelo hash do evento.
 *
 * Só delega: nenhum `catch` aqui (ver `ProcessadorBase`).
 */
@Processor(WEBHOOK_QUEUE, { concurrency: CONCORRENCIA_DO_WEBHOOK })
export class WebhookProcessor extends ProcessadorBase<
  { payload: unknown },
  unknown
> {
  protected readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private readonly rastreamentoService: RastreamentoService,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  protected executar(job: Job<{ payload: unknown }>): Promise<unknown> {
    return this.rastreamentoService.processarWebhookM7(job.data.payload);
  }
}

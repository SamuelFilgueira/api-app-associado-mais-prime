import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ehJobDeAvulsos } from 'src/notifications/domain/push-avulsos';
import {
  JOB_PUSH_LOTE,
  JOB_PUSH_RECIBOS,
  LoteJobData,
  RecibosJobData,
} from 'src/notifications/domain/push-disparo';
import { PushAvulsosService } from 'src/notifications/services/push-avulsos.service';
import { PushLoteService } from 'src/notifications/services/push-lote.service';
import { PushRecibosService } from 'src/notifications/services/push-recibos.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProcessadorBase } from 'src/queue/processador-base';
import { PUSH_MASSA_QUEUE } from 'src/queue/queue.module';
import { DomainError } from 'src/shared/erros/erros';

/**
 * Fila de push em MASSA, separada da fila de alerta. Três tipos de job:
 *
 *  - `push-lote`: uma página de entregas de um disparo (marketing, planilha);
 *  - `push-recibos`: consulta atrasada dos recibos de um disparo;
 *  - qualquer outro nome com `mensagens` no payload: pushes avulsos em lote
 *    (lembretes e avisos do Associado da Sorte).
 *
 * Concorrência 2: cada job é uma chamada de até 100 mensagens ao Expo.
 */
@Processor(PUSH_MASSA_QUEUE, { concurrency: 2 })
export class PushMassaProcessor extends ProcessadorBase<unknown, unknown> {
  protected readonly logger = new Logger(PushMassaProcessor.name);

  constructor(
    private readonly lotes: PushLoteService,
    private readonly recibos: PushRecibosService,
    private readonly avulsos: PushAvulsosService,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  protected async executar(job: Job<unknown>): Promise<unknown> {
    if (job.name === JOB_PUSH_LOTE) {
      return this.lotes.processar(job.data as LoteJobData);
    }
    if (job.name === JOB_PUSH_RECIBOS) {
      return this.recibos.processar(job.data as RecibosJobData);
    }

    const dados = job.data;
    if (ehJobDeAvulsos(dados)) {
      return this.avulsos.enviar(job.name, dados.mensagens, {
        progresso: dados._progresso,
        salvar: (progresso) =>
          job.updateData({ ...dados, _progresso: progresso }),
      });
    }

    throw new DomainError(
      'PUSH_JOB_DESCONHECIDO',
      `Job "${job.name}" não é atendido pela fila de push em massa.`,
    );
  }
}

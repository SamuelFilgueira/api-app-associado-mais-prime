import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  associadoSorteConfig,
  SORTE_CICLO_JOB,
  SORTE_EMAIL_RETIRADA_JOB,
} from 'src/associado-sorte/config/associado-sorte.config';
import {
  EmailRetiradaJob,
  SorteNotificacoesAdminService,
} from 'src/associado-sorte/services/sorte-notificacoes-admin.service';
import {
  CicloResultado,
  SorteCicloService,
} from 'src/associado-sorte/services/sorte-ciclo.service';
import { ASSOCIADO_SORTE_QUEUE } from 'src/queue/queue.module';

/**
 * Consome os jobs do Associado da Sorte: o ciclo periódico e o e-mail de
 * retirada. Só delega: as regras ficam nos services. Concorrência 1 para as
 * execuções do ciclo não se sobreporem.
 */
@Processor(ASSOCIADO_SORTE_QUEUE, { concurrency: 1 })
export class SorteCicloProcessor extends WorkerHost {
  private readonly logger = new Logger(SorteCicloProcessor.name);

  constructor(
    private readonly ciclo: SorteCicloService,
    private readonly notificacoesAdmin: SorteNotificacoesAdminService,
  ) {
    super();
  }

  async process(job: Job): Promise<CicloResultado | null> {
    if (job.name === SORTE_CICLO_JOB) {
      // Agendador desligado (padrão): execução residual no Redis é descartada
      // em silêncio — nenhum lembrete, apuração ou alerta.
      if (!associadoSorteConfig().agendadorAtivo) return null;
      return this.ciclo.executar();
    }
    if (job.name === SORTE_EMAIL_RETIRADA_JOB) {
      const { notificacaoId } = job.data as EmailRetiradaJob;
      await this.notificacoesAdmin.enviarEmailRetirada(Number(notificacaoId));
      return null;
    }
    this.logger.warn(`Job desconhecido ignorado: ${job.name}`);
    return null;
  }
}

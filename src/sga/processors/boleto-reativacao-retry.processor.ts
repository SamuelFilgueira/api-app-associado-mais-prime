import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProcessadorBase } from 'src/queue/processador-base';
import { BOLETO_REATIVACAO_RETRY_QUEUE } from 'src/queue/queue.module';
import {
  AGENDADOR_VARREDURA_RETRY,
  INTERVALO_VARREDURA_RETRY_MS,
  JOB_VARRER_RETRY_BOLETO,
} from 'src/sga/config/boleto-reativacao-retry.config';
import { BoletoReativacaoRetryJobData } from 'src/sga/services/boleto-reativacao.service';
import { BoletoRetryVarreduraService } from 'src/sga/services/boleto-retry-varredura.service';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';

/**
 * Retry da criação do boleto de reativação.
 *
 * Um único agendador roda a varredura das revistorias em `PENDENTE_RETRY`
 * com tentativa vencida (`BoletoRetryVarreduraService`). Os jobs atrasados
 * do formato antigo (um por revistoria) que ainda estiverem no Redis
 * continuam sendo atendidos, mas são inofensivos: só tentam se a revistoria
 * estiver aguardando retry e na hora, e o lease impede a tentativa em dobro.
 *
 * Nada é capturado aqui: o que falhar aparece como job falho.
 */
@Processor(BOLETO_REATIVACAO_RETRY_QUEUE as string)
export class BoletoReativacaoRetryProcessor
  extends ProcessadorBase<Partial<BoletoReativacaoRetryJobData>, unknown>
  implements OnApplicationBootstrap
{
  protected readonly logger = new Logger(BoletoReativacaoRetryProcessor.name);

  constructor(
    private readonly varredura: BoletoRetryVarreduraService,
    private readonly gerar: GerarBoletoReativacaoService,
    @InjectQueue(BOLETO_REATIVACAO_RETRY_QUEUE as string)
    private readonly fila: Queue,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  /**
   * Garante o agendador da varredura. Ele fica gravado no Redis: falhar aqui
   * num boot não remove o que um boot anterior criou.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.fila.upsertJobScheduler(
        AGENDADOR_VARREDURA_RETRY,
        { every: INTERVALO_VARREDURA_RETRY_MS },
        {
          name: JOB_VARRER_RETRY_BOLETO,
          opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 50 },
        },
      );
    } catch (error) {
      this.logger.error(
        `Não foi possível agendar a varredura de retry do boleto de reativação: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected async executar(
    job: Job<Partial<BoletoReativacaoRetryJobData>>,
  ): Promise<unknown> {
    if (job.name === JOB_VARRER_RETRY_BOLETO) {
      return this.varredura.executar();
    }

    // Job atrasado do formato antigo: uma tentativa, sem reagendar outro job.
    const { reinspectionId, debugId } = job.data;
    return this.gerar.processar(Number(reinspectionId), {
      origem: 'RETRY',
      debugId,
    });
  }
}

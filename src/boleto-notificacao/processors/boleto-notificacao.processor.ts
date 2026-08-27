import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { BOLETO_NOTIFICACAO_QUEUE } from 'src/queue/queue.module';
import { parseDateBR } from 'src/shared/date.util';
import {
  BoletoNotificacaoService,
  JOB_EXECUTAR_ROTINA,
  JOB_VERIFICAR_RECEIPTS,
} from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { BoletoNotificacaoReceiptsService } from 'src/boleto-notificacao/services/boleto-notificacao-receipts.service';
import { TipoMensagem } from 'src/boleto-notificacao/config/boleto-notificacao.config';

interface ExecutarRotinaJobData {
  origem?: 'AGENDADA' | 'MANUAL';
  dataReferencia?: string; // dd/mm/yyyy
  tenants?: string[];
  tipos?: TipoMensagem[];
  dryRun?: boolean;
}

interface VerificarReceiptsJobData {
  execucaoId: number;
  tentativa: number;
}

const MAX_TENTATIVAS_RECEIPTS = 3;

/**
 * Worker da fila BOLETO_NOTIFICACAO_QUEUE:
 *  - executar-rotina: rotina diária (agendada ou manual)
 *  - verificar-receipts: confirmação de entrega via receipts do Expo
 */
@Processor(BOLETO_NOTIFICACAO_QUEUE as string)
export class BoletoNotificacaoProcessor extends WorkerHost {
  private readonly logger = new Logger(BoletoNotificacaoProcessor.name);

  constructor(
    private readonly notificacaoService: BoletoNotificacaoService,
    private readonly receiptsService: BoletoNotificacaoReceiptsService,
    @InjectQueue(BOLETO_NOTIFICACAO_QUEUE as string)
    private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_EXECUTAR_ROTINA:
        return this.executarRotina(job as Job<ExecutarRotinaJobData>);
      case JOB_VERIFICAR_RECEIPTS:
        return this.verificarReceipts(job as Job<VerificarReceiptsJobData>);
      default:
        this.logger.warn(
          `[BOLETO-NOTIF] job desconhecido ignorado: ${job.name}`,
        );
        return null;
    }
  }

  private async executarRotina(job: Job<ExecutarRotinaJobData>) {
    const data = job.data ?? {};
    const dataReferencia = data.dataReferencia
      ? parseDateBR(data.dataReferencia)
      : null;

    if (data.dataReferencia && !dataReferencia) {
      throw new Error(
        `dataReferencia inválida no job: "${data.dataReferencia}" (esperado dd/mm/yyyy)`,
      );
    }

    this.logger.log(
      `[BOLETO-NOTIF] job ${job.id} (${data.origem ?? 'AGENDADA'}) iniciado — tentativa ${job.attemptsMade + 1}`,
    );

    const resultados = await this.notificacaoService.executarRotina({
      origem: data.origem ?? 'AGENDADA',
      dataReferencia: dataReferencia ?? undefined,
      tenants: data.tenants,
      tipos: data.tipos,
      dryRun: data.dryRun === true,
    });

    // Falha em algum momento não derruba o job (idempotência garante reprocesso seguro),
    // mas é registrada no retorno para inspeção no BullMQ.
    return resultados.map((r) => ({
      tenant: r.tenant,
      tipo: r.tipo,
      dataAlvo: r.dataAlvo,
      status: r.status,
      execucaoId: r.execucaoId,
      enviados: r.metricas.totalEnviados,
      erro: r.erro,
    }));
  }

  private async verificarReceipts(job: Job<VerificarReceiptsJobData>) {
    const { execucaoId, tentativa } = job.data;
    const resultado = await this.receiptsService.verificarExecucao(execucaoId);

    // Receipts ainda não disponíveis: reagenda até o limite de tentativas
    if (resultado.pendentes > 0 && tentativa < MAX_TENTATIVAS_RECEIPTS) {
      const proxima = tentativa + 1;
      await this.queue.add(
        JOB_VERIFICAR_RECEIPTS,
        { execucaoId, tentativa: proxima },
        {
          delay: 15 * 60_000,
          jobId: `boleto-notificacao-receipts-${execucaoId}-${proxima}`,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      this.logger.log(
        `[BOLETO-NOTIF][RECEIPTS] execução #${execucaoId}: ${resultado.pendentes} pendente(s) — nova verificação (${proxima}/${MAX_TENTATIVAS_RECEIPTS}) em 15 min`,
      );
    }

    return resultado;
  }
}

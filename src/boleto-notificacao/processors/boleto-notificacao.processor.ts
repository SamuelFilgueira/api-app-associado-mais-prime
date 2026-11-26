import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { baseDoJob } from 'src/queue/job-envelope';
import { ProcessadorBase } from 'src/queue/processador-base';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { BOLETO_NOTIFICACAO_QUEUE } from 'src/queue/queue.module';
import { formatDateBR, parseDateBR } from 'src/shared/date.util';
import { DomainError } from 'src/shared/erros/erros';
import {
  avaliarRegua,
  basesJaConcluidas,
  ProgressoDoJob,
  progressoAposTentativa,
  ReguaIncompletaError,
} from 'src/boleto-notificacao/domain/regua-resultado';
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
  /** Bases que uma tentativa anterior deste job já fechou, e para qual data. */
  progresso?: ProgressoDoJob;
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
export class BoletoNotificacaoProcessor extends ProcessadorBase<
  ExecutarRotinaJobData | VerificarReceiptsJobData,
  unknown
> {
  protected readonly logger = new Logger(BoletoNotificacaoProcessor.name);

  constructor(
    private readonly notificacaoService: BoletoNotificacaoService,
    private readonly receiptsService: BoletoNotificacaoReceiptsService,
    private readonly produtor: ProdutorDeFilas,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  protected async executar(
    job: Job<ExecutarRotinaJobData | VerificarReceiptsJobData>,
  ): Promise<unknown> {
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
      // Repetir não conserta a data: vai direto para a fila de mortos.
      throw new DomainError(
        'REGUA_DATA_INVALIDA',
        `dataReferencia inválida no job: "${data.dataReferencia}" (esperado dd/mm/yyyy)`,
      );
    }

    // Retry: as bases que este job já fechou PARA esta data não repetem a
    // varredura do SGA. O progresso de outra data é ignorado.
    const referencia = data.dataReferencia ?? formatDateBR(new Date());
    const jaConcluidas = basesJaConcluidas(data.progresso, referencia);

    this.logger.log(
      `[BOLETO-NOTIF] job ${job.id} (${data.origem ?? 'AGENDADA'}) iniciado — tentativa ${job.attemptsMade + 1}` +
        (jaConcluidas.length > 0
          ? ` — já concluídas: ${jaConcluidas.join(',')}`
          : ''),
    );

    const resultados = await this.notificacaoService.executarRotina({
      origem: data.origem ?? 'AGENDADA',
      // Com progresso em mãos, a data fica presa à dele (a mesma de hoje).
      dataReferencia:
        dataReferencia ??
        (jaConcluidas.length > 0
          ? (parseDateBR(referencia) ?? undefined)
          : undefined),
      tenants: data.tenants,
      tipos: data.tipos,
      dryRun: data.dryRun === true,
      basesJaConcluidas: jaConcluidas.length > 0 ? jaConcluidas : undefined,
    });

    // Base em falha (SGA fora, token bloqueado) ou com envio pendente: o job
    // FALHA para a fila repetir. A idempotência por log garante que quem já
    // recebeu não recebe de novo. Dry-run não envia nada: só relata.
    const avaliacao = avaliarRegua(resultados);
    if (avaliacao.incompleta && data.dryRun !== true) {
      const progresso = progressoAposTentativa(avaliacao, jaConcluidas);
      if (progresso) await job.updateData({ ...data, progresso });
      throw new ReguaIncompletaError(avaliacao);
    }

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
      await this.produtor.enfileirar(
        BOLETO_NOTIFICACAO_QUEUE,
        JOB_VERIFICAR_RECEIPTS,
        { execucaoId, tentativa: proxima },
        {
          // A nova verificação herda a base (tenant da execução) do job atual.
          base: baseDoJob(job.data),
          // Tentativas, backoff e retenção vêm do padrão da fila (`filas.ts`).
          opcoes: {
            delay: 15 * 60_000,
            jobId: `boleto-notificacao-receipts-${execucaoId}-${proxima}`,
          },
        },
      );
      this.logger.log(
        `[BOLETO-NOTIF][RECEIPTS] execução #${execucaoId}: ${resultado.pendentes} pendente(s) — nova verificação (${proxima}/${MAX_TENTATIVAS_RECEIPTS}) em 15 min`,
      );
    }

    return resultado;
  }
}

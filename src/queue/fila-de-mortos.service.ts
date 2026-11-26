import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { metricas } from 'src/infra/observability/metricas';
import { redigirValor } from 'src/infra/observability/redacao';
import { FILAS, FILA_DE_MORTOS, NomeDaFila } from 'src/queue/filas';
import { baseDoJob, metadadosDoJob } from 'src/queue/job-envelope';

/** O que fica guardado de um job que morreu. */
export interface JobMorto {
  fila: string;
  nome: string;
  jobIdOriginal: string | undefined;
  /** Payload original, intacto: é o que o reprocessamento reenfileira. */
  dados: unknown;
  /** Opções relevantes do job original (reaplicadas ao reprocessar). */
  opcoes: { attempts?: number; backoff?: unknown };
  motivo: string;
  stack?: string;
  /** `definitivo`: erro sem retry; `esgotado`: acabaram as tentativas. */
  causa: 'definitivo' | 'esgotado';
  tentativas: number;
  baseOrigin: string | null;
  requestId?: string;
  falhouEm: string;
}

/**
 * Fila de mortos. O BullMQ não tem uma nativa: job que esgota as tentativas
 * fica em `failed` até a retenção apagar, sem avisar ninguém.
 *
 * Aqui o job esgotado (ou que falhou com erro definitivo) é copiado para a
 * fila `fila-de-mortos`, com motivo, payload e base. A cópia incrementa
 * `dlq_jobs_total` — a regra de alerta dispara a qualquer job novo — e fica
 * parada até alguém reprocessar ou descartar pelo painel.
 */
@Injectable()
export class FilaDeMortosService {
  private readonly logger = new Logger(FilaDeMortosService.name);

  constructor(
    @InjectQueue(FILA_DE_MORTOS) private readonly mortos: Queue<JobMorto>,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** O job não vai mais ser tentado pelo BullMQ? */
  static esgotado(job: Job, erro: Error): 'definitivo' | 'esgotado' | null {
    if (
      erro instanceof UnrecoverableError ||
      erro.name === 'UnrecoverableError'
    ) {
      return 'definitivo';
    }
    return job.attemptsMade >= (job.opts.attempts ?? 1) ? 'esgotado' : null;
  }

  /**
   * Copia o job para a fila de mortos. Nunca lança: falhar aqui não pode
   * mascarar o erro original nem derrubar o worker.
   */
  async receber(job: Job, erro: Error): Promise<void> {
    const causa = FilaDeMortosService.esgotado(job, erro);
    if (!causa) return;

    // Job repetível (varredura periódica) tem nova execução agendada: a
    // falha de uma rodada vira log e métrica, não um morto por rodada.
    if (job.repeatJobKey) return;

    const morto: JobMorto = {
      fila: job.queueName,
      nome: job.name,
      jobIdOriginal: job.id,
      dados: job.data as unknown,
      opcoes: { attempts: job.opts.attempts, backoff: job.opts.backoff },
      motivo: erro.message.slice(0, 1000),
      stack: erro.stack?.slice(0, 4000),
      causa,
      tentativas: job.attemptsMade,
      baseOrigin: baseDoJob(job.data),
      requestId: metadadosDoJob(job.data)?.requestId,
      falhouEm: new Date().toISOString(),
    };

    try {
      await this.mortos.add(job.queueName, morto, {
        // O mesmo job não entra duas vezes (o evento `failed` pode repetir).
        jobId: `${job.queueName}__${job.id ?? Date.now()}`,
        removeOnComplete: true,
        removeOnFail: false,
      });
      metricas.dlqJobs.inc({ queue: job.queueName });
      this.logger.error(
        `Job na fila de mortos | fila=${job.queueName} job=${job.name} id=${job.id} causa=${causa} tentativas=${job.attemptsMade} base=${morto.baseOrigin ?? '-'} | ${morto.motivo}`,
      );
    } catch (falha) {
      this.logger.error(
        `Falha ao gravar na fila de mortos (fila=${job.queueName} id=${job.id}): ${falha instanceof Error ? falha.message : String(falha)}`,
      );
    }
  }

  /** Mortos mais recentes, com o payload redigido para exibição. */
  async listar(opcoes: { fila?: string; limite?: number } = {}) {
    const limite = Math.min(Math.max(opcoes.limite ?? 50, 1), 200);
    const jobs = await this.mortos.getJobs(
      ['waiting', 'delayed'],
      0,
      999,
      false,
    );

    return jobs
      .filter((job) => !opcoes.fila || job.name === opcoes.fila)
      .slice(0, limite)
      .map((job) => ({
        id: job.id,
        ...job.data,
        dados: redigirValor(job.data.dados),
        stack: undefined,
      }));
  }

  /** Quantos mortos há por fila de origem. */
  async contarPorFila(): Promise<Record<string, number>> {
    const jobs = await this.mortos.getJobs(
      ['waiting', 'delayed'],
      0,
      4_999,
      false,
    );
    const total: Record<string, number> = {};
    for (const fila of FILAS) total[fila] = 0;
    for (const job of jobs) total[job.name] = (total[job.name] ?? 0) + 1;
    return total;
  }

  /** Reenfileira o job na fila de origem e o tira da fila de mortos. */
  async reprocessar(
    id: string,
  ): Promise<{ fila: string; jobId: string | undefined }> {
    const job = await this.mortos.getJob(id);
    if (!job) throw new Error(`Job morto ${id} não encontrado`);

    const { fila, nome, dados, opcoes } = job.data;
    const origem = this.fila(fila);
    const novo = await origem.add(nome, dados, {
      attempts: opcoes.attempts,
      backoff: opcoes.backoff as never,
    });
    await job.remove();
    this.logger.warn(
      `Job morto reprocessado | fila=${fila} job=${nome} morto=${id} novo=${novo.id}`,
    );
    return { fila, jobId: novo.id };
  }

  async descartar(id: string): Promise<void> {
    const job = await this.mortos.getJob(id);
    if (!job) throw new Error(`Job morto ${id} não encontrado`);
    await job.remove();
    this.logger.warn(
      `Job morto descartado | fila=${job.data.fila} job=${job.data.nome} morto=${id}`,
    );
  }

  private fila(nome: string): Queue {
    if (!(FILAS as readonly string[]).includes(nome)) {
      throw new Error(`Fila desconhecida: ${nome}`);
    }
    return this.moduleRef.get<Queue>(getQueueToken(nome as NomeDaFila), {
      strict: false,
    });
  }
}

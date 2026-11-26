import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { contextoExecucao } from 'src/infra/observability/contexto-execucao';
import { metricas } from 'src/infra/observability/metricas';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { baseDoJob, metadadosDoJob } from 'src/queue/job-envelope';
import { ehErroTransitorio } from 'src/shared/erros/erros';

/**
 * Base de todo processor. O processor concreto implementa `executar` e só
 * delega para um caso de uso; o que é igual para todas as filas mora aqui:
 *
 * - contexto de log: toda linha emitida durante o job sai com `queue`,
 *   `jobId`, `base` e o `requestId` de quem enfileirou;
 * - métricas de duração e resultado por fila e nome de job;
 * - classificação do erro: erro definitivo (regra de negócio, recusa do
 *   vendor) vira `UnrecoverableError` — não gasta tentativas e vai direto
 *   para a fila de mortos; erro transitório segue o retry da fila;
 * - fila de mortos quando as tentativas se esgotam.
 *
 * Regra para quem estende: NÃO capturar erro só para logar. `catch` que
 * engole a exceção conclui o job como sucesso e torna o retry inócuo.
 */
export abstract class ProcessadorBase<
  Dados = unknown,
  Retorno = unknown,
> extends WorkerHost {
  protected abstract readonly logger: Logger;

  /**
   * `false` para filas em que o chamador espera o resultado na hora (PDF):
   * a falha já volta para ele, e um morto não teria o que reprocessar.
   */
  protected readonly usaFilaDeMortos: boolean = true;

  constructor(protected readonly filaDeMortos: FilaDeMortosService) {
    super();
  }

  /** Trabalho do job. Lançar = falhou; a base decide entre retry e morto. */
  protected abstract executar(job: Job<Dados>): Promise<Retorno>;

  async process(job: Job<Dados>): Promise<Retorno> {
    const rotulos = { queue: job.queueName, name: job.name };
    const fim = metricas.filaDuracao.startTimer(rotulos);

    return contextoExecucao.executar(
      {
        requestId: metadadosDoJob(job.data)?.requestId ?? `job-${job.id}`,
        base: baseDoJob(job.data) ?? undefined,
        queue: job.queueName,
        jobId: job.id,
        jobName: job.name,
      },
      async () => {
        try {
          const retorno = await this.executar(job);
          metricas.filaProcessados.inc({ ...rotulos, resultado: 'ok' });
          return retorno;
        } catch (erro) {
          metricas.filaProcessados.inc({ ...rotulos, resultado: 'falha' });
          throw this.classificar(erro);
        } finally {
          fim();
        }
      },
    );
  }

  @OnWorkerEvent('failed')
  async aoFalhar(job: Job | undefined, erro: Error): Promise<void> {
    if (!job || !this.usaFilaDeMortos) return;
    await this.filaDeMortos.receber(job, erro);
  }

  /**
   * Erro que não adianta repetir vira `UnrecoverableError` (o BullMQ não
   * tenta de novo). A mensagem e a stack originais são preservadas.
   */
  private classificar(erro: unknown): unknown {
    if (erro instanceof UnrecoverableError) return erro;
    if (ehErroTransitorio(erro)) return erro;

    const original = erro instanceof Error ? erro : new Error(String(erro));
    const definitivo = new UnrecoverableError(original.message);
    definitivo.stack = original.stack;
    return definitivo;
  }
}

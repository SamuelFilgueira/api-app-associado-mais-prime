import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DadosDaChecagem } from 'src/fuel-session/domain/verificacao-de-economia';
import {
  ResultadoDaVerificacao,
  VerificacaoDeEconomiaService,
} from 'src/fuel-session/services/verificacao-de-economia.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProcessadorBase } from 'src/queue/processador-base';
import { FUEL_ECONOMY_QUEUE } from 'src/queue/queue.module';

/** Payload do job `check-fuel-economy`. */
export type FuelEconomyJobData = DadosDaChecagem;

/**
 * Worker da verificação de economia pós-abastecimento. Cada job é UMA
 * checagem de uma sessão; a regra está em `VerificacaoDeEconomiaService`.
 *
 * O job só falha por erro de verdade (Clubgas fora, banco, fila). Quando ele
 * morre — tentativas esgotadas ou erro definitivo — a sessão é expirada para
 * não ficar `PENDING` bloqueando o usuário.
 */
@Processor(FUEL_ECONOMY_QUEUE, { concurrency: 2 })
export class FuelEconomyProcessor extends ProcessadorBase<
  FuelEconomyJobData,
  ResultadoDaVerificacao
> {
  protected readonly logger = new Logger(FuelEconomyProcessor.name);

  constructor(
    private readonly verificacao: VerificacaoDeEconomiaService,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  protected executar(
    job: Job<FuelEconomyJobData>,
  ): Promise<ResultadoDaVerificacao> {
    return this.verificacao.verificar(job.data, job.attemptsMade);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<FuelEconomyJobData> | undefined,
    error: Error,
  ): Promise<void> {
    // Sem job (removido antes do evento) não há sessão a encerrar; tentativa
    // intermediária ainda vai repetir.
    if (!job || !FilaDeMortosService.esgotado(job, error)) return;

    const resultado = await this.verificacao.expirarAposFalhaDoJob(
      job.data.fuelSessionId,
    );
    this.logger.warn(
      `[FUEL] ⛔ job #${job.id} morreu (${error.message}) | session=${job.data.fuelSessionId} | expiração: ${resultado}`,
    );
  }

  @OnWorkerEvent('active')
  onActive(job: Job): void {
    this.logger.log(
      `[FUEL] ⚙ job #${job.id} ativo (tentativa ${job.attemptsMade + 1})`,
    );
  }
}

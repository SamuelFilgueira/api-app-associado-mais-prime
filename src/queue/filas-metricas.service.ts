import { getQueueToken } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import { papelAtivo } from 'src/config/app.config';
import { metricas } from 'src/infra/observability/metricas';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { FILAS } from 'src/queue/filas';

const INTERVALO_MS = 15_000;

/**
 * Publica o estado das filas como métrica: jobs por estado, idade do mais
 * antigo em espera e tamanho da fila de mortos. É o que alimenta os alertas
 * de "fila parada" e "fila de mortos".
 *
 * Roda só no processo com papel `worker` — uma coleta por deploy basta, e
 * assim as réplicas da API não repetem as mesmas séries.
 */
@Injectable()
export class FilasMetricasService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(FilasMetricasService.name);
  private temporizador?: NodeJS.Timeout;
  private coletando = false;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly filaDeMortos: FilaDeMortosService,
  ) {}

  onApplicationBootstrap(): void {
    if (!papelAtivo('worker')) return;
    this.temporizador = setInterval(() => void this.coletar(), INTERVALO_MS);
    this.temporizador.unref();
  }

  onApplicationShutdown(): void {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  async coletar(): Promise<void> {
    if (this.coletando) return;
    this.coletando = true;
    try {
      for (const nome of FILAS) {
        const fila = this.moduleRef.get<Queue>(getQueueToken(nome), {
          strict: false,
        });
        const contagem = await fila.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
        );
        for (const [estado, total] of Object.entries(contagem)) {
          metricas.filaJobs.set({ queue: nome, state: estado }, total);
        }

        const [maisAntigo] = await fila.getWaiting(0, 0);
        metricas.filaIdadeMaisAntigo.set(
          { queue: nome },
          maisAntigo
            ? Math.max(0, (Date.now() - maisAntigo.timestamp) / 1000)
            : 0,
        );
      }

      const mortos = await this.filaDeMortos.contarPorFila();
      for (const [fila, total] of Object.entries(mortos)) {
        metricas.dlqTamanho.set({ queue: fila }, total);
      }
    } catch (erro) {
      this.logger.warn(
        `Coleta de métricas de fila falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    } finally {
      this.coletando = false;
    }
  }
}

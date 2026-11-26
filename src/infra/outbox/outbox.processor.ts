import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { OUTBOX_QUEUE } from 'src/queue/filas';
import { ProcessadorBase } from 'src/queue/processador-base';

const JOB_DESPACHAR = 'despachar';
const AGENDADOR = 'outbox-despacho';
/** Intervalo entre rodadas do despachante. */
const INTERVALO_MS = 5_000;

/**
 * Despachante do outbox, registrado só no papel `worker`: a cada poucos
 * segundos publica na fila de destino os eventos pendentes.
 */
@Processor(OUTBOX_QUEUE)
export class OutboxProcessor
  extends ProcessadorBase<Record<string, never>, { publicados: number }>
  implements OnApplicationBootstrap
{
  protected readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    private readonly outbox: OutboxService,
    @InjectQueue(OUTBOX_QUEUE) private readonly fila: Queue,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.fila.upsertJobScheduler(
        AGENDADOR,
        { every: INTERVALO_MS },
        {
          name: JOB_DESPACHAR,
          opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 50 },
        },
      );
    } catch (erro) {
      this.logger.error(
        `Não foi possível agendar o despachante do outbox: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
  }

  protected async executar(job: Job): Promise<{ publicados: number }> {
    if (job.name !== JOB_DESPACHAR) return { publicados: 0 };
    return { publicados: await this.outbox.despachar() };
  }
}

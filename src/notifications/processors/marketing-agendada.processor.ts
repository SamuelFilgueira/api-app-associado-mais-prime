import { InjectQueue, Processor } from '@nestjs/bullmq';
import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import {
  MarketingAgendadaJobData,
  MarketingAgendamentoService,
} from 'src/notifications/services/marketing-agendamento.service';
import { PushVarreduraService } from 'src/notifications/services/push-varredura.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProcessadorBase } from 'src/queue/processador-base';
import { MARKETING_AGENDADA_QUEUE } from 'src/queue/queue.module';

export const JOB_VARREDURA_PUSH = 'varredura-push';
const AGENDADOR_DA_VARREDURA = 'push-varredura';
/** A varredura roda a cada minuto (é ela que publica a idade do envio). */
const VARREDURA_INTERVALO_MS = 60_000;
/** Espera antes de tentar registrar o agendador de novo (Redis fora no boot). */
const NOVA_TENTATIVA_MS = 30_000;

/**
 * Fila do marketing agendado, registrada só no papel `worker`:
 *
 *  - `enviar-marketing-agendada`: na hora marcada, cria o disparo e
 *    enfileira os lotes (o envio é da fila de massa);
 *  - `varredura-push`: a cada minuto, retoma o que ficou parado (ver
 *    `PushVarreduraService`). Fica nesta fila, que é quase vazia, para não
 *    esperar atrás dos lotes de uma campanha.
 *
 * Concorrência 1. Só delega; a regra fica nos services.
 */
@Processor(MARKETING_AGENDADA_QUEUE, { concurrency: 1 })
export class MarketingAgendadaProcessor
  extends ProcessadorBase<MarketingAgendadaJobData, unknown>
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected readonly logger = new Logger(MarketingAgendadaProcessor.name);
  private novaTentativa?: NodeJS.Timeout;

  constructor(
    private readonly agendamento: MarketingAgendamentoService,
    private readonly varredura: PushVarreduraService,
    @InjectQueue(MARKETING_AGENDADA_QUEUE) private readonly fila: Queue,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.agendarVarredura();
  }

  onModuleDestroy(): void {
    if (this.novaTentativa) clearTimeout(this.novaTentativa);
  }

  /**
   * Registra a varredura periódica. Não derruba o boot quando o Redis está
   * fora — mas também não desiste: tenta de novo até conseguir.
   */
  private async agendarVarredura(): Promise<void> {
    try {
      await this.fila.upsertJobScheduler(
        AGENDADOR_DA_VARREDURA,
        { every: VARREDURA_INTERVALO_MS },
        {
          name: JOB_VARREDURA_PUSH,
          opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 50 },
        },
      );
    } catch (erro) {
      this.logger.error(
        `Não foi possível agendar a varredura do push; nova tentativa em ${NOVA_TENTATIVA_MS / 1000}s: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      this.novaTentativa = setTimeout(
        () => void this.agendarVarredura(),
        NOVA_TENTATIVA_MS,
      );
      this.novaTentativa.unref();
    }
  }

  protected async executar(
    job: Job<MarketingAgendadaJobData>,
  ): Promise<unknown> {
    if (job.name === JOB_VARREDURA_PUSH) return this.varredura.executar();
    await this.agendamento.executar(Number(job.data.auditId));
    return null;
  }
}

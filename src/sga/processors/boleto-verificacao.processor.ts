import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProcessadorBase } from 'src/queue/processador-base';
import { BOLETO_VERIFICACAO_QUEUE } from 'src/queue/queue.module';
import {
  AGENDADOR_VARREDURA_BOLETOS,
  INTERVALO_VARREDURA_BOLETOS_MS,
  JOB_AVISAR_BOLETO_PAGO,
  JOB_VARRER_BOLETOS,
  JOB_VERIFICAR_BOLETO,
} from 'src/sga/config/boleto-verificacao.config';
import { DomainError } from 'src/shared/erros/erros';
import {
  AvisosBoletoPagoService,
  EventoBoletoPago,
} from 'src/sga/services/avisos-boleto-pago.service';
import {
  BoletoVerificacaoJobData,
  BoletoVerificacaoLegadoService,
} from 'src/sga/services/boleto-verificacao-legado.service';
import { BoletoVerificacaoVarreduraService } from 'src/sga/services/boleto-verificacao-varredura.service';

/**
 * Fila da verificação de pagamento do boleto de reativação. Só monta o
 * contexto e delega; a regra mora nos casos de uso:
 *
 *  - `varrer-boletos`: a varredura periódica (um agendador para todos os
 *    boletos) — `BoletoVerificacaoVarreduraService`;
 *  - `avisar-boleto-pago`: evento `boleto.pago` do outbox — e-mail e
 *    WhatsApp — `AvisosBoletoPagoService`;
 *  - `verificar-boleto`: job repetível antigo, um por boleto, com o payload
 *    antigo — `BoletoVerificacaoLegadoService`.
 */
@Processor(BOLETO_VERIFICACAO_QUEUE as string)
export class BoletoVerificacaoProcessor
  extends ProcessadorBase<unknown, unknown>
  implements OnApplicationBootstrap
{
  protected readonly logger = new Logger(BoletoVerificacaoProcessor.name);

  constructor(
    private readonly varredura: BoletoVerificacaoVarreduraService,
    private readonly legado: BoletoVerificacaoLegadoService,
    private readonly avisos: AvisosBoletoPagoService,
    @InjectQueue(BOLETO_VERIFICACAO_QUEUE as string)
    private readonly queue: Queue,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  /**
   * No boot: garante o agendador da varredura e limpa os repetíveis antigos
   * que não têm mais o que fazer. Nunca derruba o boot — o agendador fica
   * gravado no Redis, então falhar aqui não remove o de um boot anterior, e
   * a limpeza roda de novo no próximo.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        AGENDADOR_VARREDURA_BOLETOS,
        { every: INTERVALO_VARREDURA_BOLETOS_MS },
        {
          name: JOB_VARRER_BOLETOS,
          opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 50 },
        },
      );
    } catch (error) {
      this.logger.error(
        `Não foi possível agendar a varredura de boletos de reativação: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const { ativos, removidos } = await this.legado.limparPollers();
      this.logger.log(
        `Pollers de boleto de reativação (formato antigo) ativos: ${ativos}; encerrados no boot: ${removidos}`,
      );
    } catch (error) {
      this.logger.error(
        `Falha ao limpar pollers de boleto expirados: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected async executar(job: Job<unknown>): Promise<unknown> {
    switch (job.name) {
      case JOB_VARRER_BOLETOS:
        return this.varredura.executar();
      case JOB_AVISAR_BOLETO_PAGO:
        return this.avisos.executar(job.data as EventoBoletoPago);
      case JOB_VERIFICAR_BOLETO:
        return this.legado.atender(job as Job<BoletoVerificacaoJobData>);
      default:
        // Nome desconhecido: não adivinha o payload nem consulta o SGA.
        throw new DomainError(
          'JOB_DESCONHECIDO',
          `Job "${job.name}" não é atendido pela fila de verificação de boletos`,
        );
    }
  }
}

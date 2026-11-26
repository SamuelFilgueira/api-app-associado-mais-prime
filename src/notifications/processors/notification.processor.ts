import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  PushUnitarioService,
  RespostaDoPush,
  paraRespostaDoPush,
} from 'src/notifications/services/push-unitario.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProcessadorBase } from 'src/queue/processador-base';
import { NOTIFICATION_QUEUE } from 'src/queue/queue.module';
import { IntegrationError } from 'src/shared/erros/erros';

export interface NotificationJobData {
  userId: number;
  expoPushToken: string;
  title: string;
  body: string;
  data: Record<string, any>;
  /**
   * Gravado pelo próprio job quando o provedor aceita o push: a nova
   * tentativa não envia de novo, só termina de gravar a caixa de entrada.
   */
  _pushAceito?: boolean;
}

/**
 * Fila de ALERTA: um push por job (ignição, âncora, avisos avulsos, teste).
 * Push em massa não entra aqui — vai para a `PUSH_MASSA_QUEUE`, para não
 * atrasar o alerta.
 *
 * Atende qualquer nome de job com este formato, inclusive os `sorte-*` que
 * já estavam nesta fila antes de os lembretes do Associado da Sorte irem
 * para a fila de massa.
 *
 * Falha de TRANSPORTE lança: o job repete conforme o retry da fila. Recusa
 * do provedor (token inválido, mensagem rejeitada) conclui o job — repetir
 * não mudaria a resposta.
 */
@Processor(NOTIFICATION_QUEUE, { concurrency: 3 })
export class NotificationProcessor extends ProcessadorBase<
  NotificationJobData,
  RespostaDoPush
> {
  protected readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly pushUnitario: PushUnitarioService,
    filaDeMortos: FilaDeMortosService,
  ) {
    super(filaDeMortos);
  }

  protected async executar(
    job: Job<NotificationJobData>,
  ): Promise<RespostaDoPush> {
    const { userId, expoPushToken, title, body, data } = job.data;

    const resultado = await this.pushUnitario.enviar(
      { userId, expoPushToken, title, body, data },
      {
        pushAceito: job.data._pushAceito === true,
        marcarPushAceito: () =>
          job.updateData({ ...job.data, _pushAceito: true }),
      },
    );

    if (resultado.status === 'falha_transporte') {
      throw new IntegrationError({
        vendor: 'expo',
        tipo: 'indisponivel',
        detalhes: { userId, motivo: resultado.mensagem },
      });
    }
    return paraRespostaDoPush(resultado);
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(
      `[QUEUE] ⚡ job #${job.id} ativado — fila: ${job.queueName}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `[QUEUE] ✖ job #${job.id} falhou (tentativa ${job.attemptsMade}): ${error.message}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`[QUEUE] ✔ job #${job.id} processado`);
  }
}

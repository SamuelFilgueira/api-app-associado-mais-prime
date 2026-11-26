import { Injectable, Logger } from '@nestjs/common';
import { metricas } from 'src/infra/observability/metricas';
import { TravaService } from 'src/infra/redis/trava.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { WEBHOOK_QUEUE } from 'src/queue/filas';
import {
  EventoM7,
  ehEventoAtrasado,
  extrairEventoM7,
} from 'src/rastreamento/domain/evento-m7';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { EventoWebhookRepository } from 'src/rastreamento/repositories/evento-webhook.repository';
import { VeiculoRastreamentoRepository } from 'src/rastreamento/repositories/veiculo-rastreamento.repository';

/** Nome do job do webhook da M7 na `WEBHOOK_QUEUE`. */
export const JOB_EVENTO_M7 = 'm7-event';

/** Quanto a trava do evento dura se o processo morrer no meio. */
const TTL_DA_TRAVA_DO_EVENTO_MS = 60_000;

export type DesfechoDoWebhook =
  /** Evento tratado agora (push decidido e, se for o caso, enviado). */
  | 'processado'
  /** Reentrega de evento que já tinha sido tratado: nada a fazer. */
  | 'duplicado'
  /** Mais antigo que o último já tratado para o veículo e o tipo. */
  | 'descartado'
  /** Payload sem chassi: nada a gravar nem a notificar. */
  | 'ignorado';

/**
 * Outra execução está tratando este mesmo evento agora. O job falha e volta
 * depois: aí o evento já estará marcado como processado (ou livre de novo,
 * se a outra execução falhou).
 */
export class EventoEmProcessamentoError extends Error {
  constructor(hash: string) {
    super(`Evento ${hash.slice(0, 12)} já está em processamento`);
    this.name = 'EventoEmProcessamentoError';
  }
}

/**
 * Trata um evento do webhook da M7 de forma idempotente.
 *
 * 1. O evento é gravado com o hash dele (`eventoHash`, índice único). A
 *    segunda gravação do mesmo evento não cria linha; se a primeira já foi
 *    tratada, a reentrega termina aqui, sem push.
 * 2. Evento mais antigo que o último já tratado para o mesmo veículo e tipo
 *    é descartado: a fila não garante ordem, e alerta velho só confunde.
 * 3. O push sai se ALGUM vínculo ativo do chassi está com o alerta ligado —
 *    lido do veículo, com o valor do usuário quando o veículo ainda é `null`.
 * 4. Só então o evento é marcado como processado.
 *
 * Erro de banco e falha ao acionar o push PROPAGAM: o job falha e é
 * repetido. Como o evento só é marcado depois do push, a repetição retoma de
 * onde parou; como a linha é única, nada é gravado em dobro; e como o push
 * leva a chave do evento, quem já foi avisado não é avisado de novo.
 */
@Injectable()
export class ProcessarWebhookM7Service {
  private readonly logger = new Logger(ProcessarWebhookM7Service.name);

  constructor(
    private readonly eventos: EventoWebhookRepository,
    private readonly veiculos: VeiculoRastreamentoRepository,
    private readonly notifications: NotificationsService,
    private readonly m7: RastreamentoM7,
    private readonly trava: TravaService,
  ) {}

  async executar(payload: unknown) {
    const envelope = this.m7.processarWebhook(payload);
    const evento = extrairEventoM7(payload);

    if (!evento.chassi) {
      this.logger.warn(
        '[Webhook] Payload sem chassi — nada a gravar nem a notificar',
      );
      return { ...envelope, resultado: 'ignorado' as DesfechoDoWebhook };
    }

    // Uma execução por evento: job "stalled" reexecuta, e duas execuções do
    // mesmo evento mandariam dois pushes.
    const travado = await this.trava.tentar(
      `rastreamento:webhook:${evento.hash}`,
      TTL_DA_TRAVA_DO_EVENTO_MS,
      () => this.tratar(evento, payload),
    );
    if (!travado.executou) throw new EventoEmProcessamentoError(evento.hash);

    return { ...envelope, resultado: travado.valor };
  }

  private async tratar(
    evento: EventoM7,
    payload: unknown,
  ): Promise<DesfechoDoWebhook> {
    const registro = await this.eventos.registrar(evento, payload);
    if (registro.processado) {
      this.logger.log(
        `[Webhook] Evento já processado (chassi=${evento.chassi}, tipoevento=${evento.tipoevento}) — reentrega ignorada`,
      );
      return 'duplicado';
    }

    const ultimoEm = await this.eventos.ultimoProcessadoEm(evento);
    if (ehEventoAtrasado(evento.enviadoEm, ultimoEm)) {
      this.logger.warn(
        `[Webhook] Evento descartado por ser mais antigo que o último processado (chassi=${evento.chassi}, tipoevento=${evento.tipoevento}, enviado_em=${new Date(evento.enviadoEm!).toISOString()}, ultimo=${new Date(ultimoEm!).toISOString()})`,
      );
      metricas.filaProcessados.inc({
        queue: WEBHOOK_QUEUE,
        name: JOB_EVENTO_M7,
        resultado: 'descartado',
      });
      return 'descartado';
    }

    if (await this.veiculos.haAlertaLigado(evento.chassi)) {
      // A chave do evento torna o push idempotente por usuário do lado das
      // notificações: se este job repetir depois de acionar o push, o mesmo
      // alerta não é enfileirado de novo.
      await this.notifications.dispararNotificacaoVeiculoWebhook(
        evento.chassi,
        evento.tipoevento,
        evento.evento,
        { chaveDoEvento: evento.hash },
      );
    } else {
      this.logger.log(
        `[Webhook] Nenhum veículo com alerta ligado para o chassi "${evento.chassi}" — push não enviado`,
      );
    }

    if (!(await this.eventos.marcarProcessado(registro.id))) {
      // Só acontece se a trava do evento expirou com esta execução ainda viva.
      this.logger.warn(
        `[Webhook] Evento ${registro.id} já estava marcado como processado por outra execução`,
      );
    }
    return 'processado';
  }
}

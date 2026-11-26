import { Injectable } from '@nestjs/common';
import { Notification } from '@prisma/client';
import { GetNotificationsListResponseDto } from 'src/notifications/dto/get-notifications-response.dto';
import { SendMarketingNotificationDto } from 'src/notifications/dto/send-marketing-notification.dto';
import {
  AlertaVeiculoService,
  OpcoesDoAlerta,
} from 'src/notifications/services/alerta-veiculo.service';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import {
  ContextoDoPedido,
  MarketingDisparoService,
  RespostaDoDisparo,
} from 'src/notifications/services/marketing-disparo.service';
import {
  DadosDoPopup,
  PopupService,
} from 'src/notifications/services/popup.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';
import {
  PushUnitarioService,
  RespostaDoPush,
  paraRespostaDoPush,
} from 'src/notifications/services/push-unitario.service';

export type NotificationData = {
  plate?: string;
  ignition?: 'on' | 'off';
  [key: string]: any;
};

/**
 * Fachada do módulo de notificações: mantém os métodos públicos que os
 * outros módulos (rastreamento, abastecimento, Associado da Sorte) e o
 * controller sempre chamaram. Não tem regra — cada método delega para o
 * caso de uso dono do assunto:
 *
 *  - token de push ........ `PushTokenService`
 *  - push para um usuário . `PushUnitarioService`
 *  - caixa de entrada ..... `CaixaDeEntradaService`
 *  - alerta de veículo .... `AlertaVeiculoService`
 *  - disparo em massa ..... `MarketingDisparoService`
 *  - pop-up ............... `PopupService`
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly tokens: PushTokenService,
    private readonly caixa: CaixaDeEntradaService,
    private readonly pushUnitario: PushUnitarioService,
    private readonly alertas: AlertaVeiculoService,
    private readonly marketing: MarketingDisparoService,
    private readonly popups: PopupService,
  ) {}

  registerExpoPushToken(
    userId: number,
    expoPushToken: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.tokens.registrar(userId, expoPushToken);
  }

  /** Grava uma linha na caixa de entrada, sem enviar push. */
  saveNotification(
    userId: number,
    expoPushToken: string,
    title: string,
    body: string,
    data: NotificationData,
  ): Promise<Notification> {
    return this.caixa.gravar({ userId, expoPushToken, title, body, data });
  }

  /**
   * Envia um push para um usuário e grava a caixa de entrada. Nunca lança
   * por falha de envio: devolve `success: false` (contrato das rotas e dos
   * chamadores). Quem precisa repetir em falha de transporte usa a fila de
   * alerta, onde o processor decide pelo resultado completo.
   */
  async sendPushNotification(
    userId: number,
    expoPushToken: string,
    title: string,
    body: string,
    data: NotificationData,
  ): Promise<RespostaDoPush> {
    return paraRespostaDoPush(
      await this.pushUnitario.enviar({
        userId,
        expoPushToken,
        title,
        body,
        data,
      }),
    );
  }

  getUnreadNotifications(
    userId: number,
    limit: number = 50,
    offset: number = 0,
  ): Promise<GetNotificationsListResponseDto> {
    return this.caixa.naoLidas(userId, limit, offset);
  }

  getAllNotifications(
    userId: number,
    limit: number = 50,
    offset: number = 0,
  ): Promise<GetNotificationsListResponseDto> {
    return this.caixa.todas(userId, limit, offset);
  }

  markAsRead(userId: number, notificationId: number): Promise<Notification> {
    return this.caixa.marcarComoLida(userId, notificationId);
  }

  markAllAsRead(userId: number): Promise<{ count: number }> {
    return this.caixa.marcarTodasComoLidas(userId);
  }

  deleteNotification(userId: number, notificationId: number): Promise<void> {
    return this.caixa.excluir(userId, notificationId);
  }

  deleteAllUserNotifications(
    userId: number,
  ): Promise<{ deletedCount: number }> {
    return this.caixa.excluirTodas(userId);
  }

  cleanOldNotifications(
    daysOld: number = 30,
  ): Promise<{ deletedCount: number }> {
    return this.caixa.limparAntigas(daysOld);
  }

  /**
   * Disparada pelo processador de webhook da M7 (rastreamento). `opcoes` é
   * opcional: com a chave do evento, o reprocessamento do mesmo webhook não
   * gera outro push.
   */
  dispararNotificacaoVeiculoWebhook(
    chassi: string,
    tipoevento: number | null,
    evento: string | null,
    opcoes?: OpcoesDoAlerta,
  ): Promise<{ sent: number; skipped: number }> {
    return this.alertas.dispararNotificacaoVeiculoWebhook(
      chassi,
      tipoevento,
      evento,
      opcoes,
    );
  }

  /**
   * Disparo de marketing imediato: registra o pedido, cria o disparo e
   * enfileira os lotes. `sentCount` = destinatários selecionados.
   */
  sendMarketingNotification(
    payload: Pick<SendMarketingNotificationDto, 'title' | 'body' | 'data'>,
    adminUserId?: number,
  ): Promise<RespostaDoDisparo> {
    return this.marketing.dispararAgora(payload, adminUserId);
  }

  /** `POST /notifications/admin/marketing` (imediato ou agendado). */
  dispararMarketing(
    dto: SendMarketingNotificationDto,
    contexto: ContextoDoPedido,
  ) {
    return this.marketing.disparar(dto, contexto);
  }

  getActivePopup() {
    return this.popups.ativo();
  }

  upsertPopup(
    id: number | undefined,
    data: DadosDoPopup,
    userId: number,
    image?: Express.Multer.File,
  ) {
    return this.popups.gravar(id, data, userId, image);
  }
}

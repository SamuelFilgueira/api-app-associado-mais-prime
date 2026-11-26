import { Module } from '@nestjs/common';
import { ExpoModule } from 'src/integrations/expo/expo.module';
import { NotificationsController } from 'src/notifications/controllers/notifications.controller';
import { MarketingAgendadaProcessor } from 'src/notifications/processors/marketing-agendada.processor';
import { NotificationProcessor } from 'src/notifications/processors/notification.processor';
import { PushMassaProcessor } from 'src/notifications/processors/push-massa.processor';
import { PushDisparoRepository } from 'src/notifications/repositories/push-disparo.repository';
import { AlertaVeiculoService } from 'src/notifications/services/alerta-veiculo.service';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { MarketingDisparoService } from 'src/notifications/services/marketing-disparo.service';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { PopupAuditService } from 'src/notifications/services/popup-audit.service';
import { PopupService } from 'src/notifications/services/popup.service';
import { PushAvulsosService } from 'src/notifications/services/push-avulsos.service';
import { PushDisparoConsultaService } from 'src/notifications/services/push-disparo-consulta.service';
import { PushDisparoService } from 'src/notifications/services/push-disparo.service';
import { PushLoteService } from 'src/notifications/services/push-lote.service';
import { PushRecibosService } from 'src/notifications/services/push-recibos.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';
import { PushUnitarioService } from 'src/notifications/services/push-unitario.service';
import { PushVarreduraService } from 'src/notifications/services/push-varredura.service';
import { SituacaoCadastroNotificationService } from 'src/notifications/services/situacao-cadastro-notification.service';
import { paraPapel } from 'src/queue/queue.module';

/**
 * Notificações e push.
 *
 * Duas filas de envio, de propósito separadas:
 *  - `NOTIFICATION_QUEUE` (alerta): um push por job — ignição, âncora,
 *    avisos avulsos;
 *  - `PUSH_MASSA_QUEUE` (massa): lotes de disparo (marketing, planilha),
 *    recibos e os lembretes em lote do Associado da Sorte.
 *
 * Os outros módulos falam com este pelo `NotificationsService` (fachada).
 */
@Module({
  imports: [ExpoModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    // Um usuário por vez
    PushTokenService,
    PushUnitarioService,
    CaixaDeEntradaService,
    AlertaVeiculoService,
    // Em massa
    PushDisparoRepository,
    PushDisparoService,
    PushDisparoConsultaService,
    PushLoteService,
    PushRecibosService,
    PushAvulsosService,
    PushVarreduraService,
    MarketingDisparoService,
    MarketingAgendamentoService,
    MarketingNotificationAuditService,
    SituacaoCadastroNotificationService,
    // Pop-up
    PopupService,
    PopupAuditService,
    ...paraPapel('worker', [
      NotificationProcessor,
      MarketingAgendadaProcessor,
      PushMassaProcessor,
    ]),
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

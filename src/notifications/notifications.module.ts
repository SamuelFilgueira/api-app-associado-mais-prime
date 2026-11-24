import { Module } from '@nestjs/common';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { NotificationsController } from 'src/notifications/controllers/notifications.controller';
import { NotificationProcessor } from 'src/notifications/processors/notification.processor';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { SituacaoCadastroNotificationService } from 'src/notifications/services/situacao-cadastro-notification.service';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { MarketingAgendadaProcessor } from 'src/notifications/processors/marketing-agendada.processor';
import { PopupAuditService } from 'src/notifications/services/popup-audit.service';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MarketingNotificationAuditService,
    SituacaoCadastroNotificationService,
    NotificationProcessor,
    MarketingAgendamentoService,
    MarketingAgendadaProcessor,
    PopupAuditService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

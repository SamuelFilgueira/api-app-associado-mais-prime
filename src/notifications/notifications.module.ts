import { Module } from '@nestjs/common';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { NotificationsController } from 'src/notifications/controllers/notifications.controller';
import { NotificationProcessor } from 'src/notifications/processors/notification.processor';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { SituacaoCadastroNotificationService } from 'src/notifications/services/situacao-cadastro-notification.service';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MarketingNotificationAuditService,
    SituacaoCadastroNotificationService,
    NotificationProcessor,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

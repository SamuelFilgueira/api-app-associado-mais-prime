import { Module } from '@nestjs/common';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { NotificationsController } from 'src/notifications/controllers/notifications.controller';
import { AdminTokenGuard } from 'src/notifications/guards/admin-token.guard';
import { NotificationProcessor } from 'src/notifications/processors/notification.processor';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { SituacaoCadastroNotificationService } from 'src/notifications/services/situacao-cadastro-notification.service';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MarketingNotificationAuditService,
    SituacaoCadastroNotificationService,
    AdminTokenGuard,
    NotificationProcessor,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

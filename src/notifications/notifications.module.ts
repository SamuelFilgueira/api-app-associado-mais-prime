import { Module } from '@nestjs/common';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { NotificationsController } from 'src/notifications/controllers/notifications.controller';
import { AdminTokenGuard } from 'src/notifications/guards/admin-token.guard';
import { NotificationProcessor } from 'src/notifications/processors/notification.processor';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MarketingNotificationAuditService,
    AdminTokenGuard,
    NotificationProcessor,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

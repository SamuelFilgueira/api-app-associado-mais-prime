import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { AdminTokenGuard } from './admin-token.guard';
import { NotificationProcessor } from './notification.processor';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';
import { MarketingNotificationAuditService } from './marketing-notification-audit.service';
import { FileUploadService } from '../common/services/file-upload.service';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MarketingNotificationAuditService,
    FileUploadService,
    AdminTokenGuard,
    AdminPanelRoleGuard,
    NotificationProcessor,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

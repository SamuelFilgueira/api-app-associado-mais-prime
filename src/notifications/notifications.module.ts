import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { AdminTokenGuard } from './admin-token.guard';
import { NotificationProcessor } from './notification.processor';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    AdminTokenGuard,
    AdminPanelRoleGuard,
    NotificationProcessor,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

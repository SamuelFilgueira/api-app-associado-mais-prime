import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PrismaService } from '../prisma.service';
import { AdminTokenGuard } from './admin-token.guard';
import { NotificationProcessor } from './notification.processor';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, PrismaService, AdminTokenGuard, NotificationProcessor],
  exports: [NotificationsService],
})
export class NotificationsModule {}

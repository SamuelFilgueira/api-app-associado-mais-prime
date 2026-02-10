import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PrismaService } from '../prisma.service';
import { AdminTokenGuard } from './admin-token.guard';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, PrismaService, AdminTokenGuard],
  exports: [NotificationsService],
})
export class NotificationsModule {}

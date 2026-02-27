import { Module } from '@nestjs/common';
import { RastreamentoController } from './rastreamento.controller';
import { RastreamentoService } from './rastreamento.service';
import { PrismaService } from 'src/prisma.service';
import { WebhookProcessor } from './webhook.processor';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [RastreamentoController],
  providers: [RastreamentoService, PrismaService, WebhookProcessor],
})
export class RastreamentoModule {}

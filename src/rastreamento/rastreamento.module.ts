import { Module } from '@nestjs/common';
import { RastreamentoController } from './rastreamento.controller';
import { RastreamentoService } from './rastreamento.service';
import { PrismaService } from 'src/prisma.service';
import { WebhookProcessor } from './webhook.processor';
import { NotificationsModule } from '../notifications/notifications.module';
import { SharedModule } from 'src/shared/shared.module';
import { RastreamentoSoftruck } from './softruck/rastreamento-softruck.service';
import { GeoCodingService } from './softruck/services/geocoding.service';
import { RedisService } from './redis.service';
import { TrackingReportStorageService } from './tracking-report-storage.service';
import { TrackingReportProcessor } from './tracking-report.processor';

@Module({
  imports: [NotificationsModule, SharedModule],
  controllers: [RastreamentoController],
  providers: [
    RastreamentoService,
    PrismaService,
    WebhookProcessor,
    RastreamentoSoftruck,
    GeoCodingService,
    RedisService,
    TrackingReportStorageService,
    TrackingReportProcessor,
  ],
})
export class RastreamentoModule {}

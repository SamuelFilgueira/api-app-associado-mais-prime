import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AnalyticsService } from 'src/analytics/services/analytics.service';
import { AnalyticsController } from 'src/analytics/controllers/analytics.controller';
import { AnalyticsDashboardController } from 'src/analytics/controllers/analytics-dashboard.controller';
import { AnalyticsIngestProcessor } from 'src/analytics/processors/analytics-ingest.processor';
import { analyticsRedisProvider } from 'src/analytics/providers/analytics-redis.provider';
import { ANALYTICS_QUEUE } from '../queue/queue.module';

@Module({
  imports: [
    // Fila de ingestão assíncrona
    BullModule.registerQueue({ name: ANALYTICS_QUEUE }),
    // JWT para o OptionalJwtAuthGuard
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'minha_chave_secreta',
      signOptions: { expiresIn: '300d' },
    }),
  ],
  controllers: [AnalyticsController, AnalyticsDashboardController],
  providers: [
    AnalyticsService,
    AnalyticsIngestProcessor,
    analyticsRedisProvider,
  ],
})
export class AnalyticsModule {}

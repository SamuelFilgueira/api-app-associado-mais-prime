import { jwtSecret } from 'src/auth/config/auth.config';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AnalyticsService } from 'src/analytics/services/analytics.service';
import { AnalyticsController } from 'src/analytics/controllers/analytics.controller';
import { AnalyticsDashboardController } from 'src/analytics/controllers/analytics-dashboard.controller';
import { AnalyticsJourneyController } from 'src/analytics/controllers/analytics-journey.controller';
import { AnalyticsJourneyService } from 'src/analytics/services/analytics-journey.service';
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
      secret: jwtSecret(),
      signOptions: { expiresIn: '300d' },
    }),
  ],
  controllers: [
    AnalyticsController,
    AnalyticsDashboardController,
    AnalyticsJourneyController,
  ],
  providers: [
    AnalyticsService,
    AnalyticsJourneyService,
    AnalyticsIngestProcessor,
    analyticsRedisProvider,
  ],
})
export class AnalyticsModule {}

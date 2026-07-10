import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsDashboardController } from './analytics-dashboard.controller';
import { AnalyticsIngestProcessor } from './analytics-ingest.processor';
import { analyticsRedisProvider } from './analytics-redis.provider';
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
    PrismaService,
    analyticsRedisProvider,
  ],
})
export class AnalyticsModule {}

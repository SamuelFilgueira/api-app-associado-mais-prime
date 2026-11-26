import { jwtSecret } from 'src/auth/config/auth.config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AnalyticsService } from 'src/analytics/services/analytics.service';
import { AnalyticsController } from 'src/analytics/controllers/analytics.controller';
import { AnalyticsDashboardController } from 'src/analytics/controllers/analytics-dashboard.controller';
import { AnalyticsJourneyController } from 'src/analytics/controllers/analytics-journey.controller';
import { AnalyticsJourneyService } from 'src/analytics/services/analytics-journey.service';
import { AnalyticsDashboardService } from 'src/analytics/services/analytics-dashboard.service';
import { AnalyticsAplicarResumoService } from 'src/analytics/services/analytics-aplicar-resumo.service';
import { AnalyticsJornadaExpurgoService } from 'src/analytics/services/analytics-jornada-expurgo.service';
import { AnalyticsDashboardRepository } from 'src/analytics/repositories/analytics-dashboard.repository';
import { AnalyticsIngestaoRepository } from 'src/analytics/repositories/analytics-ingestao.repository';
import { AnalyticsIngestProcessor } from 'src/analytics/processors/analytics-ingest.processor';
import { paraPapel } from '../queue/queue.module';

/**
 * Analytics do app.
 *
 *  - entrada (`AnalyticsService`): barreiras, sanitização e enfileiramento;
 *  - aplicação no worker (`AnalyticsAplicarResumoService` +
 *    `AnalyticsIngestaoRepository`): agregados diários, recibo e jornada;
 *  - leitura (`AnalyticsDashboardService` + `AnalyticsDashboardRepository`,
 *    `AnalyticsJourneyService`): dashboards e jornada, sem escrita;
 *  - retenção (`AnalyticsJornadaExpurgoService`): exportado para a rotina de
 *    manutenção poder chamar `expurgarJornada()`.
 */
@Module({
  imports: [
    // A fila de analytics NÃO é registrada aqui: ela vem do `QueueModule`
    // (global), com o retry e a retenção de `OPCOES_POR_FILA`. Um segundo
    // `BullModule.registerQueue` neste módulo criaria outra instância da
    // fila, sem essas opções, e é ela que o `ProdutorDeFilas` passaria a
    // encontrar — os jobs nasceriam sem retry e nunca seriam apagados do Redis.
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
    AnalyticsDashboardService,
    AnalyticsDashboardRepository,
    AnalyticsJourneyService,
    AnalyticsAplicarResumoService,
    AnalyticsIngestaoRepository,
    AnalyticsJornadaExpurgoService,
    ...paraPapel('worker', [AnalyticsIngestProcessor]),
  ],
  exports: [AnalyticsJornadaExpurgoService],
})
export class AnalyticsModule {}

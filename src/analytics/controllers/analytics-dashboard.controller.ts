import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { AdminRoleGuard } from 'src/infra/guards/admin-role.guard';
import { AnalyticsDashboardService } from 'src/analytics/services/analytics-dashboard.service';
import { AnalyticsDashboardQueryDto } from 'src/analytics/dto/analytics-dashboard-query.dto';

/**
 * Endpoints de dashboard de analytics.
 * Protegidos por JWT + perfil ADMIN.
 */
@Controller('analytics/dashboard')
@UseGuards(JwtAuthGuard, AdminRoleGuard)
export class AnalyticsDashboardController {
  constructor(private readonly dashboards: AnalyticsDashboardService) {}

  /** Visão geral: totais de sessões, logins, ações principais e top telas. */
  @Get('overview')
  getOverview(@Query() query: AnalyticsDashboardQueryDto) {
    return this.dashboards.getDashboardOverview(query);
  }

  /** Ranking de telas por visualizações e tempo total/médio. */
  @Get('screens')
  getScreens(@Query() query: AnalyticsDashboardQueryDto) {
    return this.dashboards.getDashboardScreens(query);
  }

  /** Contadores de ações por tipo. */
  @Get('actions')
  getActions(@Query() query: AnalyticsDashboardQueryDto) {
    return this.dashboards.getDashboardActions(query);
  }

  /** Métricas de formulários com taxas de sucesso/erro. */
  @Get('forms')
  getForms(@Query() query: AnalyticsDashboardQueryDto) {
    return this.dashboards.getDashboardForms(query);
  }

  /** Série diária de sessões e instalações únicas. */
  @Get('sessions')
  getSessions(@Query() query: AnalyticsDashboardQueryDto) {
    return this.dashboards.getDashboardSessions(query);
  }

  /**
   * Audiência real: aparelhos únicos, sessões únicas, novos aparelhos,
   * DAU/WAU/MAU e stickiness. Endpoint aditivo consumido pelo Insight Hub —
   * /sessions só expõe somas diárias, que superestimam a base (aparelho-dia).
   */
  @Get('audience')
  getAudience(@Query() query: AnalyticsDashboardQueryDto) {
    return this.dashboards.getDashboardAudience(query);
  }
}

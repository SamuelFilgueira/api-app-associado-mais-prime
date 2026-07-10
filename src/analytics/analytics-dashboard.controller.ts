import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { AnalyticsService } from './analytics.service';
import { AnalyticsDashboardQueryDto } from './dto/analytics-dashboard-query.dto';

/**
 * Endpoints de dashboard de analytics.
 * Protegidos por JWT + perfil ADMIN.
 */
@Controller('analytics/dashboard')
@UseGuards(JwtAuthGuard, AdminRoleGuard)
export class AnalyticsDashboardController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /** Visão geral: totais de sessões, logins, ações principais e top telas. */
  @Get('overview')
  getOverview(@Query() query: AnalyticsDashboardQueryDto) {
    return this.analyticsService.getDashboardOverview(query);
  }

  /** Ranking de telas por visualizações e tempo total/médio. */
  @Get('screens')
  getScreens(@Query() query: AnalyticsDashboardQueryDto) {
    return this.analyticsService.getDashboardScreens(query);
  }

  /** Contadores de ações por tipo. */
  @Get('actions')
  getActions(@Query() query: AnalyticsDashboardQueryDto) {
    return this.analyticsService.getDashboardActions(query);
  }

  /** Métricas de formulários com taxas de sucesso/erro. */
  @Get('forms')
  getForms(@Query() query: AnalyticsDashboardQueryDto) {
    return this.analyticsService.getDashboardForms(query);
  }

  /** Série diária de sessões e instalações únicas. */
  @Get('sessions')
  getSessions(@Query() query: AnalyticsDashboardQueryDto) {
    return this.analyticsService.getDashboardSessions(query);
  }
}

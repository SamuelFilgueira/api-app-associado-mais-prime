import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { AdminRoleGuard } from 'src/infra/guards/admin-role.guard';
import { AnalyticsJourneyService } from 'src/analytics/services/analytics-journey.service';
import {
  AnalyticsJourneyDevicesQueryDto,
  AnalyticsJourneyQueryDto,
} from 'src/analytics/dto/analytics-journey-query.dto';

/**
 * Consultas da jornada do usuário (aparelhos logados, modelo, telas e
 * horários). Somente leitura, protegidas por JWT + perfil ADMIN.
 *
 * Os dados só existem quando ANALYTICS_JOURNEY_ENABLED=true no ambiente —
 * caso contrário todas as listas voltam vazias.
 */
@Controller('analytics/journey')
@UseGuards(JwtAuthGuard, AdminRoleGuard)
export class AnalyticsJourneyController {
  constructor(private readonly journeyService: AnalyticsJourneyService) {}

  /** Aparelhos que já usaram a conta, com modelo/SO e status (ATIVO/DESLOGADO/INATIVO). */
  @Get('users/:userId/devices')
  getUserDevices(
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: AnalyticsJourneyDevicesQueryDto,
  ) {
    return this.journeyService.getUserDevices(userId, query);
  }

  /** Linha do tempo (tela/ação/formulário) da conta, paginada por cursor. */
  @Get('users/:userId/events')
  getUserEvents(
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: AnalyticsJourneyQueryDto,
  ) {
    return this.journeyService.getUserEvents(userId, query);
  }

  /** Sessões da conta com o caminho completo percorrido em cada uma. */
  @Get('users/:userId/sessions')
  getUserSessions(
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: AnalyticsJourneyQueryDto,
  ) {
    return this.journeyService.getUserSessions(userId, query);
  }

  /** Um aparelho (installHash completo ou prefixo ≥ 8) e as contas que o usaram. */
  @Get('devices/:installHash')
  getDevice(@Param('installHash') installHash: string) {
    return this.journeyService.getDevice(installHash);
  }

  /** Linha do tempo de um aparelho, inclusive antes do login. */
  @Get('devices/:installHash/events')
  getDeviceEvents(
    @Param('installHash') installHash: string,
    @Query() query: AnalyticsJourneyQueryDto,
  ) {
    return this.journeyService.getDeviceEvents(installHash, query);
  }

  /** Eventos das contas donas de um veículo (chassi ou placa). */
  @Get('vehicles/:identifier/events')
  getVehicleEvents(
    @Param('identifier') identifier: string,
    @Query() query: AnalyticsJourneyQueryDto,
  ) {
    return this.journeyService.getVehicleEvents(identifier, query);
  }

  /** Quem viu a tela / executou a ação no intervalo, agrupado por conta+aparelho. */
  @Get('events/:name/viewers')
  getEventViewers(
    @Param('name') name: string,
    @Query() query: AnalyticsJourneyQueryDto,
  ) {
    return this.journeyService.getEventViewers(name, query);
  }
}

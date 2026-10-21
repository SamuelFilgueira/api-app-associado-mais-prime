import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  AppDirectPartnerCoordsQuery,
  AppDirectPartnersQuery,
} from 'src/direct-partners/dto/app-direct-partners.query';
import { DirectPartnerRedemptionsService } from 'src/direct-partners/services/direct-partner-redemptions.service';
import { DirectPartnersService } from 'src/direct-partners/services/direct-partners.service';
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';

type AppRequest = Request & { user?: { userId?: number | string } };

/**
 * Rotas do app do associado — Clube de Vantagens (§6).
 * Só devolve parceiros e cupons visíveis na base do JWT.
 */
@ApiTags('Parceiros diretos')
@ApiBearerAuth()
@Controller('clube/parceiros-diretos')
@UseGuards(JwtAuthGuard)
export class DirectPartnersAppController {
  constructor(
    private readonly service: DirectPartnersService,
    private readonly redemptions: DirectPartnerRedemptionsService,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({ summary: 'Lista parceiros visíveis na base do JWT' })
  listar(
    @BaseOrigin() baseOrigin: string,
    @Query() query: AppDirectPartnersQuery,
  ) {
    return this.service.listarApp(baseOrigin, query);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Detalha parceiro com cupons e estado de resgate do associado',
  })
  detalhar(
    @Param('id', ParseIntPipe) id: number,
    @BaseOrigin() baseOrigin: string,
    @Query() query: AppDirectPartnerCoordsQuery,
    @Req() req: AppRequest,
  ) {
    return this.service.detalharApp({
      id,
      baseOrigin,
      userId: this.userId(req),
      lat: query.lat,
      lng: query.lng,
    });
  }

  @Post(':id/cupons/:cupomId/resgatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resgata (uso único) ou registra uso (reutilizável) do cupom',
  })
  resgatar(
    @Param('id', ParseIntPipe) id: number,
    @Param('cupomId', ParseIntPipe) cupomId: number,
    @BaseOrigin() baseOrigin: string,
    @Req() req: AppRequest,
  ) {
    return this.redemptions.resgatar({
      partnerId: id,
      couponId: cupomId,
      userId: this.userId(req),
      baseOrigin,
    });
  }

  private userId(req: AppRequest): number {
    return Number(req.user?.userId);
  }
}

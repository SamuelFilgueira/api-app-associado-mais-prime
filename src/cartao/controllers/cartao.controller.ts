import { Controller, Get, Logger, UseGuards, Req, Query } from '@nestjs/common';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { CartaoService } from 'src/cartao/services/cartao.service';
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import type { BaseOrigin as BaseOriginType } from 'src/config/tenant.config';
import { SomenteAssociadoGuard } from 'src/infra/guards/somente-associado.guard';

@UseGuards(JwtAuthGuard, SomenteAssociadoGuard)
@Controller('cartao')
export class CartaoController {
  private readonly logger = new Logger(CartaoController.name);

  constructor(private readonly cartaoService: CartaoService) {}

  @Get('virtual')
  async gerarCartao(
    @Req() req,
    @Query('chassi') chassi: string,
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    const userId = req.user.userId;
    return this.cartaoService.gerarCartaoVirtual(userId, chassi, baseOrigin);
  }
}

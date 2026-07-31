import { Controller, Get, Logger, UseGuards, Req, Query } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { CartaoService } from 'src/cartao/services/cartao.service';
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import type { BaseOrigin as BaseOriginType } from 'src/config/tenant.config';

@UseGuards(JwtAuthGuard)
@Controller('cartao')
export class CartaoController {
  private readonly logger = new Logger(CartaoController.name);

  constructor(private readonly cartaoService: CartaoService) {}

  /** TODO: remover após testes — dispara verificação de economia sem delay */
  // @Get('test-fuel-notification')
  // async testFuelNotification(@Req() req) {
  //   return this.cartaoService.testFuelEconomyCheck(req.user.userId);
  // }

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

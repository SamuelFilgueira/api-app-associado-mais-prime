import { Controller, Get, Logger, UseGuards, Req, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CartaoService } from './cartao.service';
import { BaseContextService } from '../shared/base-context.service';
import { TokenResolverService } from '../shared/token-resolver.service';

@UseGuards(JwtAuthGuard)
@Controller('cartao')
export class CartaoController {
  private readonly logger = new Logger(CartaoController.name);

  constructor(
    private readonly cartaoService: CartaoService,
    private readonly baseContextService: BaseContextService,
    private readonly tokenResolver: TokenResolverService,
  ) {}

  private maskSecret(value?: string): string {
    if (!value) return '(vazio)';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  /** TODO: remover após testes — dispara verificação de economia sem delay */
  // @Get('test-fuel-notification')
  // async testFuelNotification(@Req() req) {
  //   return this.cartaoService.testFuelEconomyCheck(req.user.userId);
  // }

  @Get('virtual')
  async gerarCartao(@Req() req, @Query('chassi') chassi: string) {
    const userId = req.user.userId;
    const baseOrigin = this.baseContextService.getBaseOrigin();
    const clubgasTokenKey = this.tokenResolver.getTokenKey(baseOrigin, 'clubgas');
    const clubgasToken = this.baseContextService.getClubgasToken();
    this.logger.log(
      `[${baseOrigin}] cartao virtual usando tokenKey=${clubgasTokenKey} token=${this.maskSecret(clubgasToken)}`,
    );
    return this.cartaoService.gerarCartaoVirtual(
      userId,
      chassi,
      clubgasToken,
      baseOrigin,
      clubgasTokenKey,
    );
  }
}

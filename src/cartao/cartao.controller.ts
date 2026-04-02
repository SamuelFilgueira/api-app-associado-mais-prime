import { Controller, Get, UseGuards, Req, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CartaoService } from './cartao.service';

@UseGuards(JwtAuthGuard)
@Controller('cartao')
export class CartaoController {
  constructor(private readonly cartaoService: CartaoService) {}

  @Get('virtual')
  async gerarCartao(
    @Req() req,
    @Query('chassi') chassi: string,
  ) {
    const userId = req.user.userId;
    return this.cartaoService.gerarCartaoVirtual(userId, chassi);
  }
}

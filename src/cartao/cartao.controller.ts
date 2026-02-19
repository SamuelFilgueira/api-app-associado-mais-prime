import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CartaoService } from './cartao.service';

@UseGuards(JwtAuthGuard)
@Controller('cartao')
export class CartaoController {
  constructor(private readonly cartaoService: CartaoService) {}

  @Get('virtual')
  async gerarCartao(@Req() req) {
    console.log("Cartão virtual sendo gerado com os dados:", req.user);
    const userId = req.user.userId;
    return this.cartaoService.gerarCartaoVirtual(userId);
  }
}

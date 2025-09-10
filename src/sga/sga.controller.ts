import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SgaService } from './sga.service';

@UseGuards(JwtAuthGuard)
@Controller('sga')
export class SgaController {
  constructor(private readonly sgaService: SgaService) {}

  @Get('associado')
  async consultarAssociado(@Req() req) {
    const userId = req.user.userId;
    return this.sgaService.consultarAssociado(userId);
  }

  @Get('veiculos')
  async consultarVeiculos(@Req() req) {
    const userId = req.user.userId;
    return this.sgaService.consultarVeiculosAssociado(userId);
  }
}

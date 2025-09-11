import { Controller, Post, Body } from '@nestjs/common';
import { RastreamentoService } from './rastreamento.service';

@Controller('rastreamento')
export class RastreamentoController {
  constructor(private readonly rastreamentoService: RastreamentoService) {}

  @Post('renovar-token')
  async renovarToken() {
    return this.rastreamentoService.renovarToken();
  }

  @Post('ultima-posicao')
  async ultimaPosicao(@Body() body: { cnpj: string; chassi: string }) {
    return this.rastreamentoService.ultimaPosicao(body.cnpj, body.chassi);
  }
}

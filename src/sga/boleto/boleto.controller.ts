import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { BoletoService } from './boleto.service';

@UseGuards(JwtAuthGuard)
@Controller('sga/boleto')
export class BoletoController {
  constructor(private readonly boletoService: BoletoService) {}

  @Post('listar')
  async listarBoletos(@Body() body: { codigo_veiculo: number }) {
    console.log('Dados recebidos em listarBoletos:', body);
    return this.boletoService.consultarBoletosPorVeiculo(body.codigo_veiculo);
  }
}

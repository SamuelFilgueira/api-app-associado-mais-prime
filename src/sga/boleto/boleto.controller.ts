import { Controller, Post, Body, UseGuards, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { BoletoService } from './boleto.service';

@UseGuards(JwtAuthGuard)
@Controller('sga/boleto')
export class BoletoController {
  private readonly logger = new Logger(BoletoController.name);

  constructor(private readonly boletoService: BoletoService) {}

  @Post('listar')
  async listarBoletos(@Body() body: { codigo_veiculo: number }) {
    this.logger.log(`Dados recebidos em listarBoletos: ${JSON.stringify(body)}`);
    return this.boletoService.consultarBoletosPorVeiculo(body.codigo_veiculo);
  }
}

import { Body, Controller, Logger, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { JwtUser } from 'src/auth/interfaces/jwt-user.interface';
import { BoletoService } from 'src/sga/boleto/services/boleto.service';

@UseGuards(JwtAuthGuard)
@Controller('sga/boleto')
export class BoletoController {
  private readonly logger = new Logger(BoletoController.name);

  constructor(private readonly boletoService: BoletoService) {}

  @Post('listar')
  async listarBoletos(
    @Req() req: Request & { user: JwtUser },
    @Body() body: { codigo_veiculo: number },
  ) {
    return this.boletoService.consultarBoletosPorVeiculo(
      Number(req.user.userId),
      body.codigo_veiculo,
      req.user.baseOrigin,
    );
  }
}

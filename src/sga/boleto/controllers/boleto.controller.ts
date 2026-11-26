import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ehCodigoSgaValido } from 'src/sga/domain/parametros-sga';
import type { Request } from 'express';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { JwtUser } from 'src/auth/interfaces/jwt-user.interface';
import { BoletoService } from 'src/sga/boleto/services/boleto.service';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';
import { SomenteAssociadoGuard } from 'src/infra/guards/somente-associado.guard';

@UseGuards(JwtAuthGuard, SomenteAssociadoGuard)
@LimiteDeTaxa('sga')
@Controller('sga/boleto')
export class BoletoController {
  private readonly logger = new Logger(BoletoController.name);

  constructor(private readonly boletoService: BoletoService) {}

  @Post('listar')
  async listarBoletos(
    @Req() req: Request & { user: JwtUser },
    @Body() body: { codigo_veiculo: number },
  ) {
    // O corpo não passa por DTO: o código segue para o SGA e para a chave
    // de cache, então só dígitos.
    if (!ehCodigoSgaValido(body?.codigo_veiculo)) {
      throw new BadRequestException(
        'codigo_veiculo inválido: informe o código numérico do veículo',
      );
    }
    return this.boletoService.consultarBoletosPorVeiculo(
      Number(req.user.userId),
      body.codigo_veiculo,
      req.user.baseOrigin,
    );
  }
}

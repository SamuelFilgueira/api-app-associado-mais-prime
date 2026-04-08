import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { BaseContextService } from 'src/shared/base-context.service';
import { BeneficiosVeiculoService } from './beneficios-veiculo.service';

@UseGuards(JwtAuthGuard)
@Controller('sga/beneficios-veiculo')
export class BeneficiosVeiculoController {
  constructor(
    private readonly baseContextService: BaseContextService,
    private readonly beneficiosVeiculoService: BeneficiosVeiculoService,
  ) {}

  @Get(':codigoVeiculo')
  async getBeneficiosVeiculo(@Param('codigoVeiculo') codigoVeiculo: string) {
    const sgaToken = this.baseContextService.getSgaToken();

    return this.beneficiosVeiculoService.getBeneficiosVeiculo(
      sgaToken,
      codigoVeiculo,
    );
  }
}

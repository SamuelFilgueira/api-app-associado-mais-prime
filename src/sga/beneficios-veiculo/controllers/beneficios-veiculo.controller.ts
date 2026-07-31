import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { BaseContextService } from 'src/shared/base-context.service';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';

@UseGuards(JwtAuthGuard)
@Controller('sga/beneficios-veiculo')
export class BeneficiosVeiculoController {
  constructor(
    private readonly baseContextService: BaseContextService,
    private readonly beneficiosVeiculoService: BeneficiosVeiculoService,
  ) {}

  @Get(':codigoVeiculo')
  async getBeneficiosVeiculo(@Param('codigoVeiculo') codigoVeiculo: string) {
    const baseOrigin = this.baseContextService.getBaseOrigin();

    return this.beneficiosVeiculoService.getBeneficiosVeiculo(
      baseOrigin,
      codigoVeiculo,
    );
  }
}

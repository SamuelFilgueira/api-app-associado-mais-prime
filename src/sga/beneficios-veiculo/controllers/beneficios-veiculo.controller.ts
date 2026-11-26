import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import type { BaseOrigin as BaseOriginType } from 'src/config/tenant.config';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';
import { SomenteAssociadoGuard } from 'src/infra/guards/somente-associado.guard';

@UseGuards(JwtAuthGuard, SomenteAssociadoGuard)
@LimiteDeTaxa('sga')
@Controller('sga/beneficios-veiculo')
export class BeneficiosVeiculoController {
  constructor(
    private readonly beneficiosVeiculoService: BeneficiosVeiculoService,
  ) {}

  @Get(':codigoVeiculo')
  async getBeneficiosVeiculo(
    @Param('codigoVeiculo') codigoVeiculo: string,
    @BaseOrigin() baseOrigin: BaseOriginType,
  ) {
    return this.beneficiosVeiculoService.getBeneficiosVeiculo(
      baseOrigin,
      codigoVeiculo,
    );
  }
}

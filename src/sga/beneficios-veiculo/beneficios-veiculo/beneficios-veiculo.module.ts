import { Module } from '@nestjs/common';
import { BeneficiosVeiculoController } from './beneficios-veiculo.controller';
import { BeneficiosVeiculoService } from './beneficios-veiculo.service';

@Module({
  controllers: [BeneficiosVeiculoController],
  providers: [BeneficiosVeiculoService]
})
export class BeneficiosVeiculoModule {}

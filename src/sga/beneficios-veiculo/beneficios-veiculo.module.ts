import { Module } from '@nestjs/common';
import { BeneficiosVeiculoController } from 'src/sga/beneficios-veiculo/controllers/beneficios-veiculo.controller';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';

@Module({
  controllers: [BeneficiosVeiculoController],
  providers: [BeneficiosVeiculoService]
})
export class BeneficiosVeiculoModule {}

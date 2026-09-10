import { Module } from '@nestjs/common';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { BeneficiosVeiculoController } from 'src/sga/beneficios-veiculo/controllers/beneficios-veiculo.controller';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';

@Module({
  imports: [HinovaModule],
  controllers: [BeneficiosVeiculoController],
  providers: [BeneficiosVeiculoService],
})
export class BeneficiosVeiculoModule {}

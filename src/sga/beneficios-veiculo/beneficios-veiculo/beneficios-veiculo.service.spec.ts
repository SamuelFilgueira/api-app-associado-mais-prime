import { Test, TestingModule } from '@nestjs/testing';
import { BeneficiosVeiculoService } from './beneficios-veiculo.service';

describe('BeneficiosVeiculoService', () => {
  let service: BeneficiosVeiculoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BeneficiosVeiculoService],
    }).compile();

    service = module.get<BeneficiosVeiculoService>(BeneficiosVeiculoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

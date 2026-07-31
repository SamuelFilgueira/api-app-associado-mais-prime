import { Test, TestingModule } from '@nestjs/testing';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';
import { SgaAuthService } from 'src/shared/sga-auth.service';

describe('BeneficiosVeiculoService', () => {
  let service: BeneficiosVeiculoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BeneficiosVeiculoService,
        { provide: SgaAuthService, useValue: {} },
      ],
    }).compile();

    service = module.get<BeneficiosVeiculoService>(BeneficiosVeiculoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

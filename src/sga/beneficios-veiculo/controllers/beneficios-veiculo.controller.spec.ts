import { Test, TestingModule } from '@nestjs/testing';
import { BeneficiosVeiculoController } from 'src/sga/beneficios-veiculo/controllers/beneficios-veiculo.controller';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';
import { BaseContextService } from 'src/shared/base-context.service';

describe('BeneficiosVeiculoController', () => {
  let controller: BeneficiosVeiculoController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BeneficiosVeiculoController],
      providers: [
        {
          provide: BaseContextService,
          useValue: { getBaseOrigin: jest.fn() },
        },
        {
          provide: BeneficiosVeiculoService,
          useValue: { getBeneficiosVeiculo: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<BeneficiosVeiculoController>(BeneficiosVeiculoController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { BeneficiosVeiculoController } from './beneficios-veiculo.controller';
import { BeneficiosVeiculoService } from './beneficios-veiculo.service';
import { BaseContextService } from 'src/shared/base-context.service';

describe('BeneficiosVeiculoController', () => {
  let controller: BeneficiosVeiculoController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BeneficiosVeiculoController],
      providers: [
        {
          provide: BaseContextService,
          useValue: { getSgaToken: jest.fn() },
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

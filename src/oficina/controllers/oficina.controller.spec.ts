import { Test, TestingModule } from '@nestjs/testing';
import { OficinaController } from 'src/oficina/controllers/oficina.controller';
import { OficinaService } from 'src/oficina/services/oficina.service';

describe('OficinaController', () => {
  let controller: OficinaController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OficinaController],
      providers: [{ provide: OficinaService, useValue: {} }],
    }).compile();

    controller = module.get<OficinaController>(OficinaController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

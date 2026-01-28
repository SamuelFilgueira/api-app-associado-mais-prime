import { Test, TestingModule } from '@nestjs/testing';
import { DocumentosController } from './documentos.controller';

describe('DocumentosController', () => {
  let controller: DocumentosController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentosController],
    }).compile();

    controller = module.get<DocumentosController>(DocumentosController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

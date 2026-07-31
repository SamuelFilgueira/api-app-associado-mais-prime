import { Test, TestingModule } from '@nestjs/testing';
import { DocumentosController } from 'src/documentos/controllers/documentos.controller';
import { DocumentosService } from 'src/documentos/services/documentos.service';

describe('DocumentosController', () => {
  let controller: DocumentosController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentosController],
      providers: [{ provide: DocumentosService, useValue: {} }],
    }).compile();

    controller = module.get<DocumentosController>(DocumentosController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

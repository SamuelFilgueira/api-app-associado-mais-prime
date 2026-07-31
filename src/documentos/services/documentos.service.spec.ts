import { Test, TestingModule } from '@nestjs/testing';
import { DocumentosService } from 'src/documentos/services/documentos.service';
import { PrismaService } from 'src/database/prisma.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';

describe('DocumentosService', () => {
  let service: DocumentosService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentosService,
        { provide: PrismaService, useValue: {} },
        { provide: FileUploadService, useValue: {} },
      ],
    }).compile();

    service = module.get<DocumentosService>(DocumentosService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

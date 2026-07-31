import { Test, TestingModule } from '@nestjs/testing';
import { OficinaService } from 'src/oficina/services/oficina.service';
import { PrismaService } from 'src/database/prisma.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';

describe('OficinaService', () => {
  let service: OficinaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OficinaService,
        { provide: PrismaService, useValue: {} },
        { provide: FileUploadService, useValue: {} },
      ],
    }).compile();

    service = module.get<OficinaService>(OficinaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

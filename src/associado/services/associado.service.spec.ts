import { Test, TestingModule } from '@nestjs/testing';
import { AssociadoService } from 'src/associado/services/associado.service';
import { PrismaService } from 'src/database/prisma.service';
import { AuthService } from 'src/auth/services/auth.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { SgaAuthService } from 'src/shared/sga-auth.service';

describe('AssociadoService', () => {
  let service: AssociadoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssociadoService,
        { provide: PrismaService, useValue: {} },
        { provide: AuthService, useValue: {} },
        { provide: FileUploadService, useValue: {} },
        { provide: SgaAuthService, useValue: {} },
      ],
    }).compile();

    service = module.get<AssociadoService>(AssociadoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

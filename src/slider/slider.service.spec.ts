import { Test, TestingModule } from '@nestjs/testing';
import { SliderService } from './slider.service';
import { PrismaService } from 'src/prisma.service';
import { FileUploadService } from 'src/common/services/file-upload.service';

describe('SliderService', () => {
  let service: SliderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SliderService,
        {
          provide: PrismaService,
          useValue: {
            sliderInfo: {
              create: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
          },
        },
        {
          provide: FileUploadService,
          useValue: {
            uploadSliderPhoto: jest.fn(),
            deleteSliderPhoto: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SliderService>(SliderService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

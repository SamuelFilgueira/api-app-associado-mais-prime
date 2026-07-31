import { Test, TestingModule } from '@nestjs/testing';
import { SliderController } from 'src/slider/controllers/slider.controller';
import { SliderService } from 'src/slider/services/slider.service';

describe('SliderController', () => {
  let controller: SliderController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SliderController],
      providers: [
        {
          provide: SliderService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<SliderController>(SliderController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

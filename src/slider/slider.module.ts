import { Module } from '@nestjs/common';
import { SliderController } from 'src/slider/controllers/slider.controller';
import { SliderService } from 'src/slider/services/slider.service';

@Module({
  controllers: [SliderController],
  providers: [SliderService],
})
export class SliderModule {}

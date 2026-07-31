import { PartialType } from '@nestjs/mapped-types';
import { CreateSliderDto } from 'src/slider/dto/create-slider.dto';

export class UpdateSliderDto extends PartialType(CreateSliderDto) {}

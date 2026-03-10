import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { SliderService } from './slider.service';
import { CreateSliderDto } from './DTOs/create-slider.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { UpdateSliderDto } from './DTOs/update-slider.dto';

@UseGuards(JwtAuthGuard)
@Controller('slider')
export class SliderController {
  constructor(private readonly sliderService: SliderService) {}

  @Get()
  getSliders(@Query('isActive') isActive?: string) {
    const parsedIsActive =
      typeof isActive === 'string' ? isActive.toLowerCase() === 'true' : undefined;

    return this.sliderService.getSliders(parsedIsActive);
  }

  @Post()
  @UseInterceptors(FileInterceptor('image'))
  async createSlider(
    @Body() body: CreateSliderDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.sliderService.createSlider(body, image);
  }

  @Put(':id')
  @UseInterceptors(FileInterceptor('image'))
  updateSlider(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateSliderDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.sliderService.updateSlider(id, body, image);
  }

  @Delete(':id')
  deleteSlider(@Param('id', ParseIntPipe) id: number) {
    return this.sliderService.deleteSlider(id);
  }
}

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
  Patch,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { SliderService } from './slider.service';
import { CreateSliderDto } from './DTOs/create-slider.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { UpdateSliderDto } from './DTOs/update-slider.dto';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';
import { AdminPanelRoles } from '../admin-panel/admin-panel-roles.decorator';
import { AdminPanelRole } from '../admin-panel/admin-panel-role.enum';

@UseGuards(JwtAuthGuard)
@Controller('slider')
export class SliderController {
  constructor(private readonly sliderService: SliderService) {}

  @Get()
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.MARKETING)
  getSliders(@Query('isActive') isActive?: string) {
    const parsedIsActive =
      typeof isActive === 'string'
        ? isActive.toLowerCase() === 'true'
        : undefined;

    return this.sliderService.getSliders(parsedIsActive);
  }

  @Post()
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.MARKETING)
  @UseInterceptors(FileInterceptor('image'))
  async createSlider(
    @Body() body: CreateSliderDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.sliderService.createSlider(body, image);
  }

  @Patch(':id')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.MARKETING)
  @UseInterceptors(FileInterceptor('image'))
  updateSlider(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateSliderDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    return this.sliderService.updateSlider(id, body, image);
  }

  @Delete(':id')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.MARKETING)
  deleteSlider(@Param('id', ParseIntPipe) id: number) {
    return this.sliderService.deleteSlider(id);
  }
}

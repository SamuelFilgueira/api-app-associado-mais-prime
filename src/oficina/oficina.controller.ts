import {
  Body,
  Controller,
  Delete,
  Post,
  Put,
  UseGuards,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Get,
  Query,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { OficinaService } from './oficina.service';
import { CreateWorkshopDto } from './DTOs/create-workshop.dto';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { UpdateWorkshopDto } from './DTOs/update-workshop.dto';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';
import { AdminPanelRoles } from '../admin-panel/admin-panel-roles.decorator';
import {
  AdminPanelRole,
  ALL_ADMIN_PANEL_ROLES,
} from '../admin-panel/admin-panel-role.enum';

@UseGuards(JwtAuthGuard)
@Controller('oficina')
export class OficinaController {
  constructor(private readonly oficinaService: OficinaService) {}

  @Get('nearby')
  findNearby(
    @Query('lat') lat: number,
    @Query('lon') lon: number,
    @Query('radius') radius?: number,
  ) {
    return this.oficinaService.findNearbyWorkshops(
      Number(lat),
      Number(lon),
      Number(radius) || 10,
    );
  }

  @Get('all')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.EVENTOS)
  //@UseGuards(AdminRoleGuard)
  @HttpCode(HttpStatus.OK)
  async findAll(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ) {
    const pageNum = Number(page) > 0 ? Number(page) : 1;
    const limitNum = Number(limit) > 0 ? Number(limit) : 10;
    return this.oficinaService.findAllWorkshops(pageNum, limitNum);
  }

  @Get('total')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(...ALL_ADMIN_PANEL_ROLES)
  @HttpCode(HttpStatus.OK)
  getTotalWorkshops() {
    return this.oficinaService.getTotalWorkshops();
  }

  @Put(':id')
  @UseGuards(AdminRoleGuard, AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.EVENTOS)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'photoFront', maxCount: 1 },
      { name: 'photoBack', maxCount: 1 },
    ]),
  )
  async updateWorkshop(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateWorkshopDto,
    @UploadedFiles()
    files?: {
      photoFront?: Express.Multer.File[];
      photoBack?: Express.Multer.File[];
    },
  ) {
    return this.oficinaService.updateWorkshop(id, data, {
      photoFront: files?.photoFront?.[0],
      photoBack: files?.photoBack?.[0],
    });
  }

  @Post()
  @UseGuards(AdminRoleGuard, AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.EVENTOS)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'photoFront', maxCount: 1 },
      { name: 'photoBack', maxCount: 1 },
    ]),
  )
  async createWorkshop(
    @Body() data: CreateWorkshopDto,
    @UploadedFiles()
    files?: {
      photoFront?: Express.Multer.File[];
      photoBack?: Express.Multer.File[];
    },
  ) {
    return this.oficinaService.createWorkshop(data, {
      photoFront: files?.photoFront?.[0],
      photoBack: files?.photoBack?.[0],
    });
  }

  @Delete(':id')
  @UseGuards(AdminRoleGuard, AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.EVENTOS)
  @HttpCode(HttpStatus.OK)
  async removeWorkshop(@Param('id', ParseIntPipe) id: number) {
    return this.oficinaService.removeWorkshop(id);
  }
}

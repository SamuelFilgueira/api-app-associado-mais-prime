import {
  Body,
  Controller,
  Post,
  Put,
  UseGuards,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Get,
  Query,
} from '@nestjs/common';
import { OficinaService } from './oficina.service';
import { PrismaService } from 'src/prisma.service';
import { CreateWorkshopDto } from './DTOs/create-workshop.dto';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { UpdateWorkshopDto } from './DTOs/update-workshop.dto';

@UseGuards(JwtAuthGuard)
@Controller('oficina')
export class OficinaController {
  constructor(
    private readonly oficinaService: OficinaService,
    private readonly prisma: PrismaService,
  ) {}

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
  @HttpCode(HttpStatus.OK)
  async findAll(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ) {
    const pageNum = Number(page) > 0 ? Number(page) : 1;
    const limitNum = Number(limit) > 0 ? Number(limit) : 10;
    return this.oficinaService.findAllWorkshops(pageNum, limitNum);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  async updateWorkshop(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateWorkshopDto,
  ) {
    return this.oficinaService.updateWorkshop(id, data);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWorkshop(@Body() data: CreateWorkshopDto) {
    return this.oficinaService.createWorkshop(data);
  }
}

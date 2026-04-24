import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { AdminPanelUsersService } from './admin-panel-users.service';
import { CreateAdminPanelUserDto } from './dto/create-admin-panel-user.dto';
import { UpdateAdminPanelUserDto } from './dto/update-admin-panel-user.dto';

@UseGuards(JwtAuthGuard, AdminRoleGuard)
@Controller('admin-panel/users')
export class AdminPanelUsersController {
  constructor(private readonly adminPanelUsersService: AdminPanelUsersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() data: CreateAdminPanelUserDto) {
    return this.adminPanelUsersService.create(data);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  findAll() {
    return this.adminPanelUsersService.findAll();
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateAdminPanelUserDto,
  ) {
    return this.adminPanelUsersService.update(id, data);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.adminPanelUsersService.remove(id);
  }
}

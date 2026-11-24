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
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { AdminPanelRoleGuard } from 'src/infra/guards/admin-panel-role.guard';
import { AdminPanelRoles } from 'src/infra/decorators/admin-panel-roles.decorator';
import { AdminPanelRole } from 'src/infra/enums/admin-panel-role.enum';
import { AdminPanelUsersService } from 'src/admin-panel/services/admin-panel-users.service';
import { CreateAdminPanelUserDto } from 'src/admin-panel/dto/create-admin-panel-user.dto';
import { UpdateAdminPanelUserDto } from 'src/admin-panel/dto/update-admin-panel-user.dto';

/** Shape relevante do JWT do painel após o JwtStrategy.validate. */
interface AdminPanelRequest {
  user: { userId: number; adminRole?: string };
}

/**
 * Gestão dos usuários do painel — exclusiva do perfil ADMIN.
 * (Antes usava só o AdminRoleGuard, que aceita qualquer perfil do painel,
 * porque todo token do painel sai com `role: ADMIN`.)
 */
@UseGuards(JwtAuthGuard, AdminPanelRoleGuard)
@AdminPanelRoles(AdminPanelRole.ADMIN)
@Controller('admin-panel/users')
export class AdminPanelUsersController {
  constructor(
    private readonly adminPanelUsersService: AdminPanelUsersService,
  ) {}

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
    @Request() req: AdminPanelRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateAdminPanelUserDto,
  ) {
    return this.adminPanelUsersService.update(id, data, req.user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @Request() req: AdminPanelRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.adminPanelUsersService.remove(id, req.user);
  }
}

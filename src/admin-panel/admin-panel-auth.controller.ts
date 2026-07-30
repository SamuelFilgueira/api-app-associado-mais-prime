import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { AdminPanelUsersService } from './admin-panel-users.service';
import { AdminPanelLoginDto } from './dto/admin-panel-login.dto';
import { ChangeAdminPanelPasswordDto } from './dto/change-admin-panel-password.dto';

/** Shape relevante do JWT do painel após o JwtStrategy.validate. */
interface AdminPanelRequest {
  user: { userId: number; adminRole?: string };
}

@Controller('admin-panel/auth')
export class AdminPanelAuthController {
  constructor(
    private readonly adminPanelUsersService: AdminPanelUsersService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() data: AdminPanelLoginDto) {
    return this.adminPanelUsersService.login(data);
  }

  /**
   * Autoalteração de senha do usuário logado. O alvo vem do JWT — nunca do
   * body — e a senha atual é obrigatória. A restrição a tokens do painel
   * (claim `adminRole`) é validada no serviço.
   */
  @Patch('me/password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, AdminRoleGuard)
  changeOwnPassword(
    @Request() req: AdminPanelRequest,
    @Body() data: ChangeAdminPanelPasswordDto,
  ) {
    return this.adminPanelUsersService.changeOwnPassword(
      req.user.userId,
      req.user.adminRole,
      data.currentPassword,
      data.newPassword,
    );
  }
}

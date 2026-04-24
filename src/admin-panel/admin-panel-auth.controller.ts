import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AdminPanelUsersService } from './admin-panel-users.service';
import { AdminPanelLoginDto } from './dto/admin-panel-login.dto';

@Controller('admin-panel/auth')
export class AdminPanelAuthController {
  constructor(private readonly adminPanelUsersService: AdminPanelUsersService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() data: AdminPanelLoginDto) {
    return this.adminPanelUsersService.login(data);
  }
}

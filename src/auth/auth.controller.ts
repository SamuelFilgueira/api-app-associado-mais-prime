import {
  Controller,
  Post,
  Get,
  Request,
  UseGuards,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './local-auth.guard';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  async login(@Body() body: LoginDto) {
    const user = await this.authService.validateUser(
      body.cpf,
      body.password,
    );

    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    return this.authService.login(user);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@Request() req) {
    // Busca o usuário completo no banco para garantir que a placa está presente

    const user = await this.authService.getUserWithPlate(req.user.userId);
    return {
      // ...req.user,
      // plate: user?.plate || null,
      user,
    };
  }

  @Post('register')
  async register(@Body() data: RegisterDto) {
    return this.authService.register(data);
  }

  /**
   * Reset de senha: gera uma nova senha aleatória e envia por e-mail
   * POST /auth/reset-password
   * Body: { email: string }
   */
  @Post('reset-password')
  resetPassword(@Body() body: { cpf: string }) {
    return this.authService.resetPassword(body.cpf);
  }
}

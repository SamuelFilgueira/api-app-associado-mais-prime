import {
  Controller,
  Post,
  Get,
  Request,
  UseGuards,
  Body,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthService } from 'src/auth/services/auth.service';
import { LocalAuthGuard } from 'src/auth/guards/local-auth.guard';
import { RegisterDto } from 'src/auth/dto/register.dto';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { LoginDto } from 'src/auth/dto/login.dto';
import { MailService } from 'src/infra/mail/mail.service';
import { AdminTokenGuard } from 'src/infra/guards/admin-token.guard';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private mailService: MailService,
  ) {}

  @LimiteDeTaxa('autenticacao')
  @Post('login')
  async login(@Body() body: LoginDto) {
    const user = await this.authService.validateUser(body.cpf, body.password);

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

  /**
   * Cadastro direto, sem validação no SGA. O app cria contas pelo primeiro
   * acesso (`POST /associado/primeiro-acesso`); esta rota ficou só para
   * integrações internas e exige o header `x-admin-token`. Aberta, permitia
   * criar conta para qualquer CPF com senha, e-mail e base escolhidos por quem
   * chamava.
   */
  @UseGuards(AdminTokenGuard)
  @Post('register')
  async register(@Body() data: RegisterDto) {
    return this.authService.register(data);
  }

  /**
   * Reset de senha: gera uma nova senha aleatória e envia por e-mail
   * POST /auth/reset-password
   * Body: { cpf: string }
   */
  @LimiteDeTaxa('recuperacao_senha')
  @Post('reset-password')
  resetPassword(@Body() body: { cpf: string }) {
    return this.authService.resetPassword(body.cpf);
  }

  // ─── ENDPOINT DE TESTE — remova antes de subir em produção ────────────────
  // Habilite com: ENABLE_TEST_ENDPOINTS=true no .env
  @Post('test-ses-email')
  async testSesEmail(@Body() body: { to: string }) {
    if (process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
      throw new ForbiddenException('Endpoint de teste desabilitado.');
    }
    await this.mailService.sendPasswordReset(body.to, 'SenhaTest@123');
    return {
      success: true,
      message: `E-mail de teste enviado para ${body.to} via Amazon SES.`,
    };
  }
  // ─────────────────────────────────────────────────────────────────────────
}

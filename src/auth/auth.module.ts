import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from 'src/auth/services/auth.service';
import { AuthController } from 'src/auth/controllers/auth.controller';
import { JwtStrategy } from 'src/auth/strategies/jwt.strategy';
import { LocalStrategy } from 'src/auth/strategies/local.strategy';
import { PrimeiroLoginGuard } from 'src/auth/guards/primeiro-login.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'minha_chave_secreta',
      signOptions: { expiresIn: '300d' },
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    LocalStrategy,
    PrimeiroLoginGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, PrimeiroLoginGuard],
})
export class AuthModule {}

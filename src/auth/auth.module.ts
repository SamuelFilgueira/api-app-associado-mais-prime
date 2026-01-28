import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { LocalStrategy } from './local.strategy';
import { PrismaService } from '../prisma.service';
import { PrimeiroLoginGuard } from './primeiro-login.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'minha_chave_secreta',
      signOptions: { expiresIn: '1d' },
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    LocalStrategy,
    PrismaService,
    PrimeiroLoginGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, PrimeiroLoginGuard],
})
export class AuthModule {}

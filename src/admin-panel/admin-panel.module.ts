import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminPanelUsersController } from './admin-panel-users.controller';
import { AdminPanelUsersService } from './admin-panel-users.service';
import { AdminPanelAuthController } from './admin-panel-auth.controller';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'minha_chave_secreta',
      signOptions: { expiresIn: '1d' },
    }),
  ],
  controllers: [AdminPanelUsersController, AdminPanelAuthController],
  providers: [AdminPanelUsersService],
  exports: [AdminPanelUsersService],
})
export class AdminPanelModule {}

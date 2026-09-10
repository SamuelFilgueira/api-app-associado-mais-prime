import { jwtSecret } from 'src/auth/config/auth.config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminPanelUsersController } from 'src/admin-panel/controllers/admin-panel-users.controller';
import { AdminPanelUsersService } from 'src/admin-panel/services/admin-panel-users.service';
import { AdminPanelAuthController } from 'src/admin-panel/controllers/admin-panel-auth.controller';

@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: '1d' },
    }),
  ],
  controllers: [AdminPanelUsersController, AdminPanelAuthController],
  providers: [AdminPanelUsersService],
})
export class AdminPanelModule {}

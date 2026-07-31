import { Module } from '@nestjs/common';
import { AppVersionController } from 'src/app-version/controllers/app-version.controller';
import { AppVersionService } from 'src/app-version/services/app-version.service';
import { AppVersionPolicyRepository } from 'src/app-version/repositories/app-version.repository';

@Module({
  controllers: [AppVersionController],
  providers: [AppVersionService, AppVersionPolicyRepository],
  exports: [AppVersionService],
})
export class AppVersionModule {}

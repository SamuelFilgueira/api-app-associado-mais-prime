import { Module } from '@nestjs/common';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';
import { AppVersionPolicyRepository } from './app-version.repository';

@Module({
  controllers: [AppVersionController],
  providers: [AppVersionService, AppVersionPolicyRepository],
  exports: [AppVersionService],
})
export class AppVersionModule {}

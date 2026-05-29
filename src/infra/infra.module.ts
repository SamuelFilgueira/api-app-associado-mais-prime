import { Global, Module } from '@nestjs/common';
import { MailService } from '../common/services/mail.service';
import { HealthController } from './health/health.controller';

@Global()
@Module({
  controllers: [HealthController],
  providers: [MailService],
  exports: [MailService],
})
export class InfraModule {}

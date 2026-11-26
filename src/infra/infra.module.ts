import { Global, Module } from '@nestjs/common';
import { MailService } from 'src/infra/mail/mail.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { HealthController } from './health/health.controller';
import { PosseContaService } from 'src/infra/auth/posse-conta.service';
import { MetricsController } from 'src/infra/observability/metrics.controller';

@Global()
@Module({
  controllers: [HealthController, MetricsController],
  providers: [MailService, FileUploadService, PosseContaService],
  exports: [MailService, FileUploadService, PosseContaService],
})
export class InfraModule {}

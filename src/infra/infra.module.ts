import { Global, Module } from '@nestjs/common';
import { MailService } from 'src/infra/mail/mail.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { HealthController } from './health/health.controller';

@Global()
@Module({
  controllers: [HealthController],
  providers: [MailService, FileUploadService],
  exports: [MailService, FileUploadService],
})
export class InfraModule {}

import { Module } from '@nestjs/common';
import { ReinspectionController } from './reinspection.controller';
import { ReinspectionService } from './reinspection.service';
import { PrismaService } from '../prisma.service';
import { FileUploadService } from '../common/services/file-upload.service';
import { MailService } from 'src/common/services/mail.service';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';

@Module({
  controllers: [ReinspectionController],
  providers: [
    ReinspectionService,
    PrismaService,
    FileUploadService,
    MailService,
    AdminPanelRoleGuard,
  ],
})
export class ReinspectionModule {}

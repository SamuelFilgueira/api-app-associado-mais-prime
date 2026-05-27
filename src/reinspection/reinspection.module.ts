import { Module } from '@nestjs/common';
import { ReinspectionController } from './reinspection.controller';
import { ReinspectionService } from './reinspection.service';
import { PrismaService } from '../prisma.service';
import { FileUploadService } from '../common/services/file-upload.service';
import { MailService } from 'src/common/services/mail.service';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';
import { SgaService } from 'src/sga/sga.service';
import { ReinspectionPaymentsAdminController } from './reinspection-payments-admin.controller';
import { ReinspectionPaymentsAdminService } from './reinspection-payments-admin.service';

@Module({
  controllers: [ReinspectionController, ReinspectionPaymentsAdminController],
  providers: [
    ReinspectionService,
    ReinspectionPaymentsAdminService,
    PrismaService,
    FileUploadService,
    MailService,
    AdminPanelRoleGuard,
    SgaService,
  ],
})
export class ReinspectionModule {}

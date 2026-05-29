import { Module } from '@nestjs/common';
import { DocumentosService } from './documentos.service';
import { DocumentosController } from './documentos.controller';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';

@Module({
  exports: [DocumentosService],
  providers: [
    DocumentosService,
    FileUploadService,
    AdminPanelRoleGuard,
  ],
  controllers: [DocumentosController],
})
export class DocumentosModule {}

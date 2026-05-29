import { Module } from '@nestjs/common';
import { OficinaService } from './oficina.service';
import { OficinaController } from './oficina.controller';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';

@Module({
  exports: [OficinaService],
  providers: [
    OficinaService,
    FileUploadService,
    AdminPanelRoleGuard,
  ],
  controllers: [OficinaController],
})
export class OficinaModule {}

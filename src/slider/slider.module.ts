import { Module } from '@nestjs/common';
import { SliderController } from './slider.controller';
import { SliderService } from './slider.service';
import { PrismaService } from 'src/prisma.service';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { AdminPanelRoleGuard } from '../admin-panel/admin-panel-role.guard';

@Module({
  controllers: [SliderController],
  providers: [
    SliderService,
    PrismaService,
    FileUploadService,
    AdminPanelRoleGuard,
  ],
})
export class SliderModule {}

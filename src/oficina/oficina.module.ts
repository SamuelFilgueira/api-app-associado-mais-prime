import { Module } from '@nestjs/common';
import { OficinaService } from './oficina.service';
import { OficinaController } from './oficina.controller';
import { PrismaService } from '../prisma.service';
import { FileUploadService } from 'src/common/services/file-upload.service';

@Module({
  exports: [OficinaService],
  providers: [OficinaService, PrismaService, FileUploadService],
  controllers: [OficinaController],
})
export class OficinaModule {}

import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DocumentosService } from './documentos.service';
import { DocumentosController } from './documentos.controller';
import { FileUploadService } from 'src/common/services/file-upload.service';

@Module({
  exports: [DocumentosService],
  providers: [DocumentosService, PrismaService, FileUploadService],
  controllers: [DocumentosController],
})
export class DocumentosModule {}

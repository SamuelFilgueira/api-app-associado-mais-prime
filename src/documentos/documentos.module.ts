import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DocumentosService } from './documentos.service';
import { DocumentosController } from './documentos.controller';

@Module({
  exports: [DocumentosService],
  providers: [DocumentosService, PrismaService],
  controllers: [DocumentosController],
})
export class DocumentosModule {}

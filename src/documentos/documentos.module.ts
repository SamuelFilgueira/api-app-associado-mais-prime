import { Module } from '@nestjs/common';
import { DocumentosService } from './documentos.service';
import { DocumentosController } from './documentos.controller';

@Module({
  exports: [DocumentosService],
  providers: [DocumentosService],
  controllers: [DocumentosController],
})
export class DocumentosModule {}

import { Module } from '@nestjs/common';
import { DocumentosService } from 'src/documentos/services/documentos.service';
import { DocumentosController } from 'src/documentos/controllers/documentos.controller';

@Module({
  exports: [DocumentosService],
  providers: [DocumentosService],
  controllers: [DocumentosController],
})
export class DocumentosModule {}

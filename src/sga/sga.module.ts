import { Module } from '@nestjs/common';
import { SgaService } from 'src/sga/services/sga.service';
import { SgaController } from 'src/sga/controllers/sga.controller';
import { BoletoVerificacaoProcessor } from 'src/sga/processors/boleto-verificacao.processor';

@Module({
  controllers: [SgaController],
  providers: [SgaService, BoletoVerificacaoProcessor],
  exports: [SgaService],
})
export class SgaModule {}

import { Module } from '@nestjs/common';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { SgaService } from 'src/sga/services/sga.service';
import { SgaController } from 'src/sga/controllers/sga.controller';
import { BoletoVerificacaoProcessor } from 'src/sga/processors/boleto-verificacao.processor';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';

@Module({
  imports: [HinovaModule],
  controllers: [SgaController],
  providers: [SgaService, BoletoVerificacaoProcessor, SuriNotificacaoService],
  exports: [SgaService],
})
export class SgaModule {}

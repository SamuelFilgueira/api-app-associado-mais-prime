import { Module } from '@nestjs/common';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { SgaService } from 'src/sga/services/sga.service';
import { SgaController } from 'src/sga/controllers/sga.controller';
import { BoletoVerificacaoProcessor } from 'src/sga/processors/boleto-verificacao.processor';
import { BoletoReativacaoRetryProcessor } from 'src/sga/processors/boleto-reativacao-retry.processor';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import { AssociadoSincronizacaoService } from 'src/sga/services/associado-sincronizacao.service';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';

@Module({
  imports: [HinovaModule],
  controllers: [SgaController],
  providers: [
    SgaService,
    BoletoVerificacaoProcessor,
    BoletoReativacaoRetryProcessor,
    SuriNotificacaoService,
    AssociadoSincronizacaoService,
    BoletoReativacaoService,
  ],
  exports: [SgaService, BoletoReativacaoService],
})
export class SgaModule {}

import { Module } from '@nestjs/common';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { SgaBoletoPeriodoClient } from 'src/boleto-notificacao/services/sga-boleto-periodo.client';
import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { BoletoNotificacaoReceiptsService } from 'src/boleto-notificacao/services/boleto-notificacao-receipts.service';
import { BoletoNotificacaoSchedulerService } from 'src/boleto-notificacao/services/boleto-notificacao-scheduler.service';
import { BoletoNotificacaoProcessor } from 'src/boleto-notificacao/processors/boleto-notificacao.processor';
import { BoletoNotificacaoAdminController } from 'src/boleto-notificacao/controllers/boleto-notificacao-admin.controller';

/**
 * Rotina diária de notificações push do ciclo de cobrança de boletos (SGA).
 * Depende dos módulos globais DatabaseModule, QueueModule e SharedModule.
 */
@Module({
  controllers: [BoletoNotificacaoAdminController],
  providers: [
    BoletoNotificacaoConfigService,
    SgaBoletoPeriodoClient,
    BoletoNotificacaoService,
    BoletoNotificacaoReceiptsService,
    BoletoNotificacaoSchedulerService,
    BoletoNotificacaoProcessor,
  ],
  exports: [BoletoNotificacaoService],
})
export class BoletoNotificacaoModule {}

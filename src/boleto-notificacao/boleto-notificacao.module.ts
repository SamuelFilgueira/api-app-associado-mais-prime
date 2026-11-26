import { Module } from '@nestjs/common';
import { ExpoModule } from 'src/integrations/expo/expo.module';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { BoletoNotificacaoAdminController } from 'src/boleto-notificacao/controllers/boleto-notificacao-admin.controller';
import { BoletoNotificacaoProcessor } from 'src/boleto-notificacao/processors/boleto-notificacao.processor';
import { ReguaDestinatarioRepository } from 'src/boleto-notificacao/repositories/regua-destinatario.repository';
import { ReguaExecucaoRepository } from 'src/boleto-notificacao/repositories/regua-execucao.repository';
import { ReguaLogRepository } from 'src/boleto-notificacao/repositories/regua-log.repository';
import { BoletoNotificacaoConsultaService } from 'src/boleto-notificacao/services/boleto-notificacao-consulta.service';
import { BoletoNotificacaoReceiptsService } from 'src/boleto-notificacao/services/boleto-notificacao-receipts.service';
import { BoletoNotificacaoSchedulerService } from 'src/boleto-notificacao/services/boleto-notificacao-scheduler.service';
import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { ExecutarReguaService } from 'src/boleto-notificacao/services/executar-regua.service';
import { ReguaDaBaseService } from 'src/boleto-notificacao/services/regua-da-base.service';
import { ReguaEnvioService } from 'src/boleto-notificacao/services/regua-envio.service';
import { ReguaEtapaService } from 'src/boleto-notificacao/services/regua-etapa.service';
import { ReguaMetricaService } from 'src/boleto-notificacao/services/regua-metrica.service';
import { ReguaSelecaoService } from 'src/boleto-notificacao/services/regua-selecao.service';
import { SgaBoletoPeriodoClient } from 'src/boleto-notificacao/services/sga-boleto-periodo.client';
import { paraPapel } from 'src/queue/queue.module';

/**
 * Rotina diária de notificações push do ciclo de cobrança de boletos (SGA).
 * Depende dos módulos globais DatabaseModule, QueueModule, SharedModule e
 * ConsistenciaModule (trava); fala com a Hinova pelo `HinovaModule` e com o
 * Expo pela porta `PushGateway` do `ExpoModule`.
 */
@Module({
  imports: [HinovaModule, ExpoModule],
  controllers: [BoletoNotificacaoAdminController],
  providers: [
    BoletoNotificacaoConfigService,
    SgaBoletoPeriodoClient,
    ReguaExecucaoRepository,
    ReguaLogRepository,
    ReguaDestinatarioRepository,
    ReguaSelecaoService,
    ReguaEnvioService,
    ReguaEtapaService,
    ReguaDaBaseService,
    ReguaMetricaService,
    ExecutarReguaService,
    BoletoNotificacaoService,
    BoletoNotificacaoConsultaService,
    BoletoNotificacaoReceiptsService,
    BoletoNotificacaoSchedulerService,
    ...paraPapel('worker', [BoletoNotificacaoProcessor]),
  ],
})
export class BoletoNotificacaoModule {}

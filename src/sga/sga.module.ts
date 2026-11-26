import { Module, OnModuleInit } from '@nestjs/common';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { HinovaModule } from 'src/integrations/hinova/hinova.module';
import { BOLETO_VERIFICACAO_QUEUE, paraPapel } from 'src/queue/queue.module';
import { JOB_AVISAR_BOLETO_PAGO } from 'src/sga/config/boleto-verificacao.config';
import { SgaController } from 'src/sga/controllers/sga.controller';
import { BoletoReativacaoRetryProcessor } from 'src/sga/processors/boleto-reativacao-retry.processor';
import { BoletoVerificacaoProcessor } from 'src/sga/processors/boleto-verificacao.processor';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';
import {
  EVENTO_BOLETO_PAGO,
  PagamentoBoletoRepository,
} from 'src/sga/repositories/pagamento-boleto.repository';
import { AssociadoSincronizacaoService } from 'src/sga/services/associado-sincronizacao.service';
import { AvisosBoletoPagoService } from 'src/sga/services/avisos-boleto-pago.service';
import { BoletoAdocaoService } from 'src/sga/services/boleto-adocao.service';
import { BoletoCriacaoService } from 'src/sga/services/boleto-criacao.service';
import { BoletoDesfechoService } from 'src/sga/services/boleto-desfecho.service';
import { BoletoObtencaoService } from 'src/sga/services/boleto-obtencao.service';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import { BoletoRetryVarreduraService } from 'src/sga/services/boleto-retry-varredura.service';
import { BoletoVerificacaoLegadoService } from 'src/sga/services/boleto-verificacao-legado.service';
import { BoletoVerificacaoVarreduraService } from 'src/sga/services/boleto-verificacao-varredura.service';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';
import { ReativacaoPosPagamentoService } from 'src/sga/services/reativacao-pos-pagamento.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';
import { SgaConsultaService } from 'src/sga/services/sga-consulta.service';
import { SgaVeiculoInfoService } from 'src/sga/services/sga-veiculo-info.service';
import { SgaService } from 'src/sga/services/sga.service';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import { VeiculosSincronizacaoService } from 'src/sga/services/veiculos-sincronizacao.service';
import { VerificarPagamentoBoletoService } from 'src/sga/services/verificar-pagamento-boleto.service';

/**
 * SGA (Hinova): consultas do app e boleto de reativação da revistoria.
 *
 * Os processors (varreduras e jobs antigos) sobem só no papel `worker`. Os
 * casos de uso ficam registrados em todos os papéis: a API gera o boleto na
 * aprovação e no "Gerar agora"; o worker faz o retry, a verificação de
 * pagamento e os avisos.
 */
@Module({
  imports: [HinovaModule],
  controllers: [SgaController],
  providers: [
    // Fachadas (API pública do módulo)
    SgaService,
    BoletoReativacaoService,
    // Consultas do app
    SgaConsultaService,
    SgaVeiculoInfoService,
    VeiculosSincronizacaoService,
    AssociadoSincronizacaoService,
    // Boleto de reativação: geração
    SgaBoletoClient,
    BoletoReativacaoRepository,
    PagamentoBoletoRepository,
    BoletoCriacaoService,
    BoletoAdocaoService,
    BoletoObtencaoService,
    BoletoDesfechoService,
    GerarBoletoReativacaoService,
    BoletoRetryVarreduraService,
    // Boleto de reativação: verificação de pagamento e avisos
    VerificarPagamentoBoletoService,
    ReativacaoPosPagamentoService,
    BoletoVerificacaoVarreduraService,
    BoletoVerificacaoLegadoService,
    AvisosBoletoPagoService,
    SuriNotificacaoService,
    ...paraPapel('worker', [
      BoletoVerificacaoProcessor,
      BoletoReativacaoRetryProcessor,
    ]),
  ],
  exports: [SgaService, BoletoReativacaoService],
})
export class SgaModule implements OnModuleInit {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Destino do evento `boleto.pago`: o despachante do outbox publica na fila
   * de verificação, e o `BoletoVerificacaoProcessor` entrega aos avisos.
   */
  onModuleInit(): void {
    this.outbox.registrarDestino(EVENTO_BOLETO_PAGO, {
      fila: BOLETO_VERIFICACAO_QUEUE,
      job: JOB_AVISAR_BOLETO_PAGO,
    });
  }
}

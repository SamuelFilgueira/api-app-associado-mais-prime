import { Injectable, Logger } from '@nestjs/common';
import { metricas } from 'src/infra/observability/metricas';
import { debugLog } from 'src/shared/debug-log.util';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import {
  BoletoVerificacaoConfig,
  getBoletoVerificacaoConfig,
} from 'src/sga/config/boleto-verificacao.config';
import {
  BoletoSgaCru,
  lerSituacaoDaConsulta,
  lerSituacaoDaListagem,
} from 'src/sga/domain/boleto-sga.parser';
import { estadoDoBoleto } from 'src/sga/domain/boleto-situacao';
import {
  PagamentoBoletoRepository,
  PagamentoDoBoleto,
} from 'src/sga/repositories/pagamento-boleto.repository';
import {
  BoletoEmVerificacao,
  ReativacaoPosPagamentoService,
} from 'src/sga/services/reativacao-pos-pagamento.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';

/**
 * Como terminou uma verificação:
 *  - `EM_ABERTO`: o boleto segue sem pagamento; consultar de novo depois;
 *  - `SEM_RESPOSTA`: o SGA respondeu erro; consultar de novo depois;
 *  - `CANCELADO`: cancelado/excluído no SGA — verificação encerrada;
 *  - `PAGO_E_REATIVADO`: pago e com veículo e associado reativados —
 *    verificação encerrada.
 */
export type DesfechoDaVerificacao =
  | 'EM_ABERTO'
  | 'SEM_RESPOSTA'
  | 'CANCELADO'
  | 'PAGO_E_REATIVADO';

/**
 * Uma verificação de pagamento de um boleto de reativação: consulta a
 * situação no SGA (sempre direto, sem cache), grava o resultado e, se pago,
 * conclui a reativação. É o mesmo caminho para a varredura e para o job
 * repetível antigo.
 *
 * Falha ao gravar o resultado LANÇA: sem a linha gravada não há marcador
 * confiável do que já foi feito. Recusa do SGA na reativação também lança —
 * nos dois casos nada encerra e a próxima rodada tenta de novo.
 */
@Injectable()
export class VerificarPagamentoBoletoService {
  private readonly logger = new Logger(VerificarPagamentoBoletoService.name);
  private readonly config: BoletoVerificacaoConfig =
    getBoletoVerificacaoConfig();
  /** Instante da última sondagem ao SGA feita por este processo. */
  private ultimaChamadaSgaEm = 0;

  constructor(
    private readonly client: SgaBoletoClient,
    private readonly pagamentos: PagamentoBoletoRepository,
    private readonly posPagamento: ReativacaoPosPagamentoService,
  ) {}

  async verificar(
    boleto: BoletoEmVerificacao,
    base: BaseOrigin,
    anterior: Pick<PagamentoDoBoleto, 'pago' | 'pagoEm' | 'reativadoEm'> | null,
  ): Promise<DesfechoDaVerificacao> {
    const consulta = await this.consultarSituacao(boleto, base);
    if (!consulta) return 'SEM_RESPOSTA';

    const estado = estadoDoBoleto(consulta.codigoSituacao);
    const pago = estado === 'PAGO';

    // Grava em toda consulta (o `updatedAt` da linha é a "última consulta"
    // da cadência do job antigo). Pago: o evento `boleto.pago` entra no
    // outbox na mesma transação.
    await this.pagamentos.gravarConsulta({
      userVehicleId: boleto.userVehicleId,
      nossoNumero: boleto.nossoNumero,
      situacao: consulta.codigoSituacao ?? 'PENDENTE',
      pago,
      agora: new Date(),
      pagoEmAnterior: anterior?.pagoEm,
      linhaDigitavel: consulta.boleto?.linha_digitavel ?? null,
      linkBoleto: consulta.boleto?.link_boleto ?? null,
      dados: {
        baseOrigin: base,
        codigoVeiculo: boleto.codigoVeiculo,
        codigoAssociado: boleto.codigoAssociado,
        nomeAssociado: boleto.nomeAssociado,
        telefoneAssociado: boleto.telefoneAssociado,
      },
      debugId: boleto.debugId,
    });

    if (estado === 'ENCERRADO') {
      this.logger.log(
        debugLog(
          VerificarPagamentoBoletoService.name,
          'Verificação encerrada: boleto cancelado/excluído no SGA',
          boleto.debugId,
          {
            nossoNumero: boleto.nossoNumero,
            situacao: consulta.codigoSituacao,
          },
        ),
      );
      await this.pagamentos.encerrar(boleto.nossoNumero, new Date());
      return 'CANCELADO';
    }

    if (!pago) return 'EM_ABERTO';

    if (!anterior?.pago) {
      metricas.boletoReativacao.inc({ base, evento: 'pago' });
    }
    this.logger.log(
      debugLog(
        VerificarPagamentoBoletoService.name,
        'Boleto pago! Reativando veículo',
        boleto.debugId,
        {
          nossoNumero: boleto.nossoNumero,
          codigoVeiculo: boleto.codigoVeiculo,
        },
      ),
    );

    await this.posPagamento.executar(boleto, base, anterior);
    await this.pagamentos.encerrar(boleto.nossoNumero, new Date());
    return 'PAGO_E_REATIVADO';
  }

  /**
   * Situação do boleto no SGA: `processa-pdf/boleto` e, quando ele não
   * informa a situação, a listagem de boletos do veículo. `null` = o SGA
   * respondeu erro na consulta principal.
   */
  private async consultarSituacao(
    boleto: BoletoEmVerificacao,
    base: BaseOrigin,
  ): Promise<{
    codigoSituacao: string | undefined;
    boleto: BoletoSgaCru | undefined;
  } | null> {
    const meta = { nossoNumero: boleto.nossoNumero };

    await this.espacarChamadaSga();
    const resposta = await this.client.consultarBoleto(
      base,
      boleto.nossoNumero,
    );
    if (resposta.status >= 400) {
      this.logger.warn(
        debugLog(
          VerificarPagamentoBoletoService.name,
          'Erro ao verificar boleto',
          boleto.debugId,
          { ...meta, status: resposta.status, body: resposta.data },
        ),
      );
      return null;
    }

    const lida = lerSituacaoDaConsulta(resposta.data, boleto.nossoNumero);
    if (lida.codigoSituacao) return lida;

    // `processa-pdf` veio vazio/sem situação: consulta os boletos do veículo.
    await this.espacarChamadaSga();
    const listagem = await this.client.listarBoletosDoVeiculo(
      base,
      boleto.codigoVeiculo,
    );
    if (listagem.status >= 400 || !Array.isArray(listagem.data)) {
      this.logger.warn(
        debugLog(
          VerificarPagamentoBoletoService.name,
          'Fallback retornou erro',
          boleto.debugId,
          { ...meta, status: listagem.status },
        ),
      );
      return lida;
    }

    const naLista = lerSituacaoDaListagem(listagem.data, boleto.nossoNumero);
    if (naLista.codigoSituacao === undefined) {
      this.logger.warn(
        debugLog(
          VerificarPagamentoBoletoService.name,
          'Fallback sem status para nosso_numero informado',
          boleto.debugId,
          { ...meta, encontrados: naLista.encontrados },
        ),
      );
      return lida;
    }
    return { codigoSituacao: naLista.codigoSituacao, boleto: naLista.boleto };
  }

  /**
   * Garante um espaçamento mínimo entre sondagens consecutivas ao SGA
   * (varredura e jobs antigos somados): a Hinova bloqueia o token de base
   * por rajada.
   */
  private async espacarChamadaSga(): Promise<void> {
    const espera =
      this.ultimaChamadaSgaEm + this.config.espacamentoMs - Date.now();
    if (espera > 0) {
      await new Promise((resolve) => setTimeout(resolve, espera));
    }
    this.ultimaChamadaSgaEm = Date.now();
  }
}

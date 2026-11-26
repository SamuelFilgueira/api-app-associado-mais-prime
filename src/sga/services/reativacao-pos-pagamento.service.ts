import { Injectable, Logger } from '@nestjs/common';
import { getRegraRevistoria } from 'src/config/revistoria-regra.config';
import { metricas } from 'src/infra/observability/metricas';
import { debugLog } from 'src/shared/debug-log.util';
import { IntegrationError } from 'src/shared/erros/erros';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { ehStatusInstavel } from 'src/sga/helpers/sga-instabilidade.helper';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import {
  RespostaDoSga,
  SgaBoletoClient,
} from 'src/sga/services/sga-boleto.client';

/** O boleto em verificação: o que o job antigo trazia e a linha guarda. */
export interface BoletoEmVerificacao {
  userVehicleId: number;
  nossoNumero: string;
  codigoVeiculo: string;
  codigoAssociado: number | null;
  nomeAssociado: string | null;
  telefoneAssociado: string | null;
  debugId?: string;
}

/**
 * Depois que o boleto de reativação é pago: reativa o veículo e o associado
 * no SGA (situações da regra da base).
 *
 * As duas etapas precisam ser aceitas pelo SGA. Qualquer recusa LANÇA — a
 * verificação não encerra e a próxima rodada tenta de novo, sem repetir o
 * que já foi feito: `reativadoEm` marca o veículo já reativado, e o aviso
 * (e-mail e WhatsApp) corre por fora, pelo evento `boleto.pago` do outbox.
 */
@Injectable()
export class ReativacaoPosPagamentoService {
  private readonly logger = new Logger(ReativacaoPosPagamentoService.name);

  constructor(
    private readonly client: SgaBoletoClient,
    private readonly pagamentos: PagamentoBoletoRepository,
  ) {}

  async executar(
    boleto: BoletoEmVerificacao,
    base: BaseOrigin,
    marcadores: { reativadoEm: Date | null } | null,
  ): Promise<void> {
    const regra = getRegraRevistoria(base).boleto;
    const dono = await this.pagamentos.donoDoVeiculo(boleto.userVehicleId);
    const leituras = { cpf: dono?.cpf, codigoVeiculo: boleto.codigoVeiculo };

    // O pagamento acabou de ser detectado: o app não pode seguir mostrando o
    // boleto em aberto que está guardado no cache das leituras.
    await this.client.invalidarLeituras(base, leituras);

    if (!marcadores?.reativadoEm) {
      const resposta = await this.client.alterarSituacaoDoVeiculo(
        base,
        regra.situacaoVeiculoAposPagamento,
        boleto.codigoVeiculo,
      );
      // Sem checar o status, um 403/5xx do SGA virava "Veículo reativado" e
      // a verificação encerrava: o associado pagava e o veículo seguia
      // inativo.
      if (resposta.status >= 400) {
        throw this.recusa(
          boleto,
          base,
          resposta,
          `o veículo ${boleto.codigoVeiculo}`,
          regra.situacaoVeiculoAposPagamento,
        );
      }
      await this.pagamentos.marcarReativado(boleto.nossoNumero, new Date());
      metricas.boletoReativacao.inc({ base, evento: 'reativado' });
      this.logger.log(
        debugLog(
          ReativacaoPosPagamentoService.name,
          `Veículo reativado (situação ${regra.situacaoVeiculoAposPagamento})`,
          boleto.debugId,
          { codigoVeiculo: boleto.codigoVeiculo, status: resposta.status },
        ),
      );
    }

    if (boleto.codigoAssociado) {
      const resposta = await this.client.alterarSituacaoDoAssociado(
        base,
        regra.situacaoAssociadoAposPagamento,
        boleto.codigoAssociado,
      );
      // Antes só gerava um aviso e a verificação encerrava com o associado
      // ainda inativo. Agora falha: a próxima rodada tenta de novo (o
      // veículo, já marcado em `reativadoEm`, não é reativado outra vez).
      if (resposta.status >= 400) {
        throw this.recusa(
          boleto,
          base,
          resposta,
          `o associado ${boleto.codigoAssociado}`,
          regra.situacaoAssociadoAposPagamento,
        );
      }
    } else {
      this.logger.warn(
        debugLog(
          ReativacaoPosPagamentoService.name,
          'codigo_associado ausente; reativação de associado não executada',
          boleto.debugId,
          {
            nossoNumero: boleto.nossoNumero,
            userVehicleId: boleto.userVehicleId,
          },
        ),
      );
    }

    // Situação nova do veículo e do associado: vale o mesmo que acima.
    await this.client.invalidarLeituras(base, leituras);
  }

  private recusa(
    boleto: BoletoEmVerificacao,
    base: BaseOrigin,
    resposta: RespostaDoSga,
    alvo: string,
    situacao: number,
  ): IntegrationError {
    metricas.boletoReativacao.inc({ base, evento: 'falha_reativacao' });
    this.logger.error(
      debugLog(
        ReativacaoPosPagamentoService.name,
        `SGA recusou a reativação de ${alvo} (situação ${situacao}); a verificação segue ativa`,
        boleto.debugId,
        {
          nossoNumero: boleto.nossoNumero,
          status: resposta.status,
          body: resposta.data,
        },
      ),
    );
    return new IntegrationError({
      vendor: 'hinova',
      base,
      tipo: ehStatusInstavel(resposta.status) ? 'indisponivel' : 'recusado',
      statusVendor: resposta.status,
      message: `Boleto ${boleto.nossoNumero} pago, mas o SGA respondeu HTTP ${resposta.status} ao reativar ${alvo}`,
    });
  }
}

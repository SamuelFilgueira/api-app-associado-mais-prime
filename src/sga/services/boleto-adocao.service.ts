import { Injectable } from '@nestjs/common';
import { getRegraRevistoria } from 'src/config/revistoria-regra.config';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import {
  BoletoReativacaoRetryConfig,
  getBoletoReativacaoRetryConfig,
} from 'src/sga/config/boleto-reativacao-retry.config';
import {
  BoletoAdotavel,
  localizarPorNossoNumero,
  referenciaDaRevistoria,
  selecionarBoletoParaAdocao,
} from 'src/sga/domain/boleto-adocao';
import { BoletoIdentificado } from 'src/sga/domain/boleto-sga.parser';
import { BoletoCriacaoService } from 'src/sga/services/boleto-criacao.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';

/** O que identifica a revistoria e o veículo numa adoção ou retomada. */
export interface AlvoDoBoleto {
  reinspectionId: number;
  userVehicleId: number;
  base: BaseOrigin;
  cpf: string;
  debugId?: string;
}

function meiaNoite(agora: Date): Date {
  const hoje = new Date(agora);
  hoje.setHours(0, 0, 0, 0);
  return hoje;
}

/**
 * Boleto que JÁ EXISTE no SGA para a revistoria: em vez de cadastrar outro,
 * a API grava o pagamento local e avisa o associado.
 *
 *  - adoção: boleto criado à mão por uma operadora, ou criado pela própria
 *    API numa tentativa cuja resposta se perdeu;
 *  - retomada: boleto cadastrado pela API cujo `nosso_numero` ficou gravado
 *    na revistoria, mas a gravação do pagamento falhou.
 */
@Injectable()
export class BoletoAdocaoService {
  private readonly config: BoletoReativacaoRetryConfig =
    getBoletoReativacaoRetryConfig();

  constructor(
    private readonly client: SgaBoletoClient,
    private readonly criacao: BoletoCriacaoService,
  ) {}

  /**
   * Procura o boleto a adotar: primeiro pela referência da revistoria
   * (`REV-<id>`), depois por tipo de reativação + em aberto + vencimento de
   * hoje em diante. Erro do SGA aqui é instabilidade (vale retry).
   */
  async localizar(
    alvo: Pick<AlvoDoBoleto, 'reinspectionId' | 'base'>,
    codigoVeiculo: string,
    agora: Date,
  ): Promise<BoletoAdotavel | null> {
    const hoje = meiaNoite(agora);
    const itens = await this.client.listarBoletosParaAdocao(
      alvo.base,
      codigoVeiculo,
      hoje,
      this.config.janelaVencimentoDias,
    );
    return selecionarBoletoParaAdocao(itens, {
      codigoVeiculo,
      codigoTipoBoleto: getRegraRevistoria(alvo.base).boleto.codigoTipoBoleto,
      hoje,
      referencia: referenciaDaRevistoria(alvo.reinspectionId),
    });
  }

  /** Grava o pagamento do boleto adotado e envia o WhatsApp com o link. */
  async adotar(
    alvo: AlvoDoBoleto,
    boleto: BoletoIdentificado & { nossoNumero: string },
    codigoVeiculo: string | null,
  ): Promise<{ suriEnviada: boolean }> {
    const associado = await this.client.buscarDadosAssociadoParaBoleto(
      alvo.cpf,
      alvo.base,
    );
    await this.criacao.registrarPagamentoBoleto({
      userVehicleId: alvo.userVehicleId,
      reinspectionId: alvo.reinspectionId,
      nossoNumero: boleto.nossoNumero,
      linhaDigitavel: boleto.linhaDigitavel,
      linkBoleto: boleto.linkBoleto,
      debugId: alvo.debugId,
      baseOrigin: alvo.base,
      codigoVeiculo,
      associado,
    });
    const concluido = await this.criacao.concluirBoletoReativacao({
      userVehicleId: alvo.userVehicleId,
      baseOrigin: alvo.base,
      nossoNumero: boleto.nossoNumero,
      linkBoleto: boleto.linkBoleto,
      codigoVeiculo,
      associado,
      debugId: alvo.debugId,
    });
    return { suriEnviada: concluido.suriEnviada };
  }

  /**
   * Conclui um boleto que a API já cadastrou (o `nosso_numero` está na
   * revistoria). NUNCA cadastra outro: busca o link na listagem do veículo
   * (se o SGA não o devolver, segue sem link), grava o pagamento, aplica a
   * situação do veículo que o cadastro não chegou a aplicar e avisa.
   */
  async retomar(
    alvo: AlvoDoBoleto,
    nossoNumero: string,
    veiculo: { codigoVeiculo: string | null; plate: string },
    agora: Date,
  ): Promise<{ linkBoleto: string | null; suriEnviada: boolean }> {
    const codigoVeiculo =
      veiculo.codigoVeiculo ??
      (await this.client.buscarProdutosDoVeiculo(veiculo.plate, alvo.base))
        .codigoVeiculo ??
      null;

    const itens = codigoVeiculo
      ? await this.client.listarBoletosParaAdocao(
          alvo.base,
          codigoVeiculo,
          meiaNoite(agora),
          this.config.janelaVencimentoDias,
        )
      : null;
    const noSga = localizarPorNossoNumero(itens, nossoNumero);
    const boleto = {
      nossoNumero,
      linhaDigitavel: noSga?.linhaDigitavel ?? null,
      linkBoleto: noSga?.linkBoleto ?? null,
    };

    const { suriEnviada } = await this.adotar(alvo, boleto, codigoVeiculo);

    await this.criacao.aplicarSituacaoAposBoleto(
      alvo.base,
      codigoVeiculo,
      getRegraRevistoria(alvo.base).boleto.situacaoVeiculoAposBoleto,
    );
    await this.client.invalidarLeituras(alvo.base, {
      cpf: alvo.cpf,
      codigoVeiculo,
    });
    return { linkBoleto: boleto.linkBoleto, suriEnviada };
  }
}

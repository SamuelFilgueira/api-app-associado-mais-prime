import { Injectable } from '@nestjs/common';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { formatDateBR } from 'src/shared/date.util';
import {
  BoletoIdentificado,
  DadosAssociadoBoleto,
  ProdutosDoVeiculo,
  lerAssociadoParaBoleto,
  lerBoletoCadastrado,
  lerProdutosDoVeiculo,
  nossoNumeroParaSga,
} from 'src/sga/domain/boleto-sga.parser';
import { BoletoReativacaoDefinitivoError } from 'src/sga/errors/boleto-reativacao.error';
import {
  erroDaExcecaoSga,
  erroDaRespostaSga,
} from 'src/sga/helpers/sga-instabilidade.helper';
import { janelaVencimentoBoleto } from 'src/sga/helpers/janela-boleto.helper';
import {
  BoletoEmAberto,
  DIAS_POR_JANELA_DE_BUSCA,
  JANELAS_DE_BUSCA,
  selecionarUltimoBoletoEmAberto,
} from 'src/sga/domain/boleto-encargos';
import { SITUACAO_BOLETO_ABERTO } from 'src/sga/domain/boleto-situacao';

/** Timeout do `boleto/cadastrar` (gera boleto e link no SGA). */
const SGA_BOLETO_TIMEOUT_MS = 60_000;
/** Timeout da listagem de boletos do veículo na busca por boleto a adotar. */
const SGA_LISTAR_TIMEOUT_MS = 30_000;

/** Resultado de `cancelarBoleto`. */
export interface ResultadoDoCancelamento {
  cancelado: boolean;
  /** Por que não cancelou (texto para o registro e para o e-mail). */
  motivo: string | null;
}

/** Resposta do SGA como o axios devolve; quem chama decide pelo `status`. */
export interface RespostaDoSga {
  status: number;
  data: unknown;
}

/**
 * Chamadas ao SGA (Hinova) do fluxo do boleto de reativação: o que cada
 * endpoint recebe e como a resposta vira erro tipado ou dado do domínio.
 *
 * As chamadas da GERAÇÃO lançam `BoletoReativacaoInstabilidadeError` (vale
 * retry) ou `BoletoReativacaoDefinitivoError`. As da VERIFICAÇÃO de
 * pagamento devolvem a resposta crua, sempre SEM cache: ali o que interessa
 * é o valor do instante.
 */
@Injectable()
export class SgaBoletoClient {
  constructor(
    private readonly sgaAuth: SgaAuthService,
    private readonly hinova: HinovaClient,
  ) {}

  // ── Geração do boleto ─────────────────────────────────────────────────────

  /**
   * Dados do associado usados no boleto e nos avisos (`associado/buscar`,
   * pela leitura com cache — os mesmos dados que o app acabou de consultar).
   */
  async buscarDadosAssociadoParaBoleto(
    cpf: string,
    base: BaseOrigin,
  ): Promise<DadosAssociadoBoleto> {
    const etapa = 'associado/buscar';
    const resposta = await this.chamar(etapa, () =>
      this.hinova.buscarAssociado(base, cpf),
    );

    const associado = lerAssociadoParaBoleto(resposta.data);
    if (!associado) {
      throw new BoletoReativacaoDefinitivoError(
        'associado/buscar: resposta sem codigo_associado',
        etapa,
        resposta.status,
      );
    }
    return associado;
  }

  /** Produtos vinculados ao veículo: valor, taxa e `codigo_veiculo`. */
  async buscarProdutosDoVeiculo(
    placa: string,
    base: BaseOrigin,
  ): Promise<ProdutosDoVeiculo> {
    const resposta = await this.chamar('produto-vinculado-veiculo', () =>
      this.sgaAuth.executeRequestWithAuth(base, {
        method: 'GET',
        url: `${SGA_BASE_URL}/produto-vinculado-veiculo/listar/${placa}`,
        validateStatus: () => true,
        compartilharEmVoo: true,
      }),
    );
    return lerProdutosDoVeiculo(resposta.data);
  }

  /**
   * `POST /boleto/cadastrar`. Escrita: nunca compartilhada em voo, nunca
   * repetida aqui. `encontrado = false` quando o 2xx não trouxe os dados do
   * boleto em nenhum formato conhecido.
   */
  async cadastrarBoleto(
    base: BaseOrigin,
    payload: Record<string, unknown>,
  ): Promise<BoletoIdentificado & { encontrado: boolean; cru: unknown }> {
    const resposta = await this.chamar('boleto/cadastrar', () =>
      this.sgaAuth.executeRequestWithAuth(base, {
        method: 'POST',
        url: `${SGA_BASE_URL}/boleto/cadastrar`,
        data: payload,
        headers: { 'Content-Type': 'application/json' },
        timeout: SGA_BOLETO_TIMEOUT_MS,
        validateStatus: () => true,
      }),
    );
    return { ...lerBoletoCadastrado(resposta.data), cru: resposta.data };
  }

  /**
   * Boletos do veículo com vencimento original de hoje até hoje + N dias —
   * a lista em que a adoção procura um boleto já existente. `null` quando o
   * SGA responde "nenhum boleto" (404/406) ou um corpo que não é lista.
   * Erro do SGA aqui é instabilidade ou definitivo, como nas demais.
   */
  async listarBoletosParaAdocao(
    base: BaseOrigin,
    codigoVeiculo: string,
    hoje: Date,
    janelaDias: number,
  ): Promise<unknown[] | null> {
    const etapa = 'listar/boleto-associado-veiculo';
    const fim = new Date(hoje);
    fim.setDate(fim.getDate() + janelaDias);

    let resposta: RespostaDoSga;
    try {
      resposta = await this.sgaAuth.executeRequestWithAuth(base, {
        method: 'POST',
        url: `${SGA_BASE_URL}/listar/boleto-associado-veiculo`,
        data: {
          codigo_veiculo: Number(codigoVeiculo),
          data_vencimento_original_inicial: formatDateBR(hoje),
          data_vencimento_original_final: formatDateBR(fim),
        },
        headers: { 'Content-Type': 'application/json' },
        timeout: SGA_LISTAR_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (error) {
      throw erroDaExcecaoSga(etapa, error);
    }

    // 404/sem boletos é resposta normal ("nenhum boleto"), não erro.
    if (resposta.status === 404 || resposta.status === 406) return null;
    if (resposta.status >= 400) {
      throw erroDaRespostaSga(etapa, resposta.status, resposta.data);
    }
    return Array.isArray(resposta.data) ? (resposta.data as unknown[]) : null;
  }

  // ── Encargos por atraso (regra por empresa) ───────────────────────────────

  /**
   * O último boleto EM ABERTO do veículo com vencimento até hoje — a base
   * para contar o atraso. A listagem do SGA aceita no máximo 90 dias por
   * consulta: procura da janela mais recente para trás e para na primeira
   * que tiver boleto em aberto (uma chamada, no caso comum).
   *
   * Erro do SGA aqui é instabilidade ou definitivo, como nas demais chamadas
   * da geração: sem saber do boleto em aberto o valor não pode ser calculado.
   */
  async buscarUltimoBoletoEmAberto(
    base: BaseOrigin,
    codigoVeiculo: string,
    hoje: Date,
  ): Promise<BoletoEmAberto | null> {
    const etapa = 'listar/boleto-associado-veiculo (em aberto)';

    for (let janela = 0; janela < JANELAS_DE_BUSCA; janela++) {
      const fim = new Date(hoje);
      fim.setDate(fim.getDate() - janela * DIAS_POR_JANELA_DE_BUSCA);
      const inicio = new Date(fim);
      inicio.setDate(inicio.getDate() - (DIAS_POR_JANELA_DE_BUSCA - 1));

      let resposta: RespostaDoSga;
      try {
        resposta = await this.sgaAuth.executeRequestWithAuth(base, {
          method: 'POST',
          url: `${SGA_BASE_URL}/listar/boleto-associado-veiculo`,
          data: {
            codigo_veiculo: Number(codigoVeiculo),
            codigo_situacao_boleto: Number(SITUACAO_BOLETO_ABERTO),
            data_vencimento_inicial: formatDateBR(inicio),
            data_vencimento_final: formatDateBR(fim),
          },
          headers: { 'Content-Type': 'application/json' },
          timeout: SGA_LISTAR_TIMEOUT_MS,
          validateStatus: () => true,
        });
      } catch (error) {
        throw erroDaExcecaoSga(etapa, error);
      }

      // 404/406 = "nenhum boleto" nesta janela: tenta a anterior.
      if (resposta.status === 404 || resposta.status === 406) continue;
      if (resposta.status >= 400) {
        throw erroDaRespostaSga(etapa, resposta.status, resposta.data);
      }
      const ultimo = selecionarUltimoBoletoEmAberto(resposta.data, {
        codigoVeiculo,
        hoje,
      });
      if (ultimo) return ultimo;
    }
    return null;
  }

  /**
   * Cancela um boleto no SGA.
   *
   * NÃO IMPLEMENTADO DE PROPÓSITO: a documentação pública da API da Hinova
   * (SGA v2, consultada em 26/11/2026 — 136 endpoints) não tem nenhuma rota
   * para cancelar, excluir ou mudar a situação de um boleto. As de escrita
   * em boleto são só `boleto/cadastrar` e `alterar/vencimento-boleto`.
   * Chamar uma rota adivinhada em produção não é opção.
   *
   * Quando a Hinova informar a rota (método, caminho, corpo e resposta),
   * este é o ÚNICO ponto a implementar: devolver `{ cancelado: true }` no
   * sucesso. Até lá o boleto antigo fica registrado como pendente de
   * cancelamento manual (`ReinspectionPayment.encargos.cancelamento`) e o
   * e-mail da cobrança avisa.
   */
  cancelarBoleto(
    _base: BaseOrigin,
    _nossoNumero: string,
  ): Promise<ResultadoDoCancelamento> {
    return Promise.resolve({
      cancelado: false,
      motivo:
        'A API do SGA não documenta cancelamento de boleto; aguardando a Hinova informar a rota',
    });
  }

  // ── Situação do veículo e do associado ────────────────────────────────────

  /** `GET /veiculo/alterar-situacao-para/:situacao/:codigoVeiculo`. */
  alterarSituacaoDoVeiculo(
    base: BaseOrigin,
    situacao: number,
    codigoVeiculo: string,
  ): Promise<RespostaDoSga> {
    return this.sgaAuth.executeRequestWithAuth(base, {
      method: 'GET',
      url: `${SGA_BASE_URL}/veiculo/alterar-situacao-para/${situacao}/${codigoVeiculo}`,
      validateStatus: () => true,
    });
  }

  /** `GET /associado/alterar-situacao-para/:situacao/:codigoAssociado`. */
  alterarSituacaoDoAssociado(
    base: BaseOrigin,
    situacao: number,
    codigoAssociado: number,
  ): Promise<RespostaDoSga> {
    return this.sgaAuth.executeRequestWithAuth(base, {
      method: 'GET',
      url: `${SGA_BASE_URL}/associado/alterar-situacao-para/${situacao}/${codigoAssociado}`,
      validateStatus: () => true,
    });
  }

  // ── Verificação de pagamento (sem cache) ──────────────────────────────────

  /** `POST /processa-pdf/boleto`: situação do boleto pelo `nosso_numero`. */
  consultarBoleto(
    base: BaseOrigin,
    nossoNumero: string,
  ): Promise<RespostaDoSga> {
    return this.sgaAuth.executeRequestWithAuth(base, {
      method: 'POST',
      url: `${SGA_BASE_URL}/processa-pdf/boleto`,
      data: { nosso_numero: nossoNumeroParaSga(nossoNumero) },
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
  }

  /** Boletos do veículo (hoje ± 45 dias), direto no SGA. */
  listarBoletosDoVeiculo(
    base: BaseOrigin,
    codigoVeiculo: string,
  ): Promise<RespostaDoSga> {
    return this.sgaAuth.executeRequestWithAuth(base, {
      method: 'POST',
      url: `${SGA_BASE_URL}/listar/boleto-associado-veiculo`,
      data: this.filtroDosBoletos(codigoVeiculo),
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
  }

  // ── Cache das leituras do app ─────────────────────────────────────────────

  /**
   * O associado acabou de ter boleto gerado, pago ou veículo reativado: a
   * próxima abertura do app precisa ver o valor novo, não o guardado.
   */
  async invalidarLeituras(
    base: BaseOrigin,
    alvo: { cpf?: string | null; codigoVeiculo?: string | null },
  ): Promise<void> {
    if (alvo.cpf) await this.hinova.invalidarAssociado(base, alvo.cpf);
    if (alvo.codigoVeiculo && /^\d+$/.test(alvo.codigoVeiculo)) {
      await this.hinova.invalidarBoletos(
        base,
        this.filtroDosBoletos(alvo.codigoVeiculo),
      );
    }
  }

  /** O mesmo filtro (e a mesma chave de cache) da listagem de boletos do app. */
  private filtroDosBoletos(codigoVeiculo: string) {
    const { dataInicialStr, dataFinalStr } = janelaVencimentoBoleto();
    return {
      codigo_veiculo: Number(codigoVeiculo),
      data_vencimento_original_inicial: dataInicialStr,
      data_vencimento_original_final: dataFinalStr,
    };
  }

  /** Executa a chamada e converte exceção e status de erro em erro tipado. */
  private async chamar(
    etapa: string,
    requisicao: () => Promise<RespostaDoSga>,
  ): Promise<RespostaDoSga> {
    let resposta: RespostaDoSga;
    try {
      resposta = await requisicao();
    } catch (error) {
      throw erroDaExcecaoSga(etapa, error);
    }
    if (resposta.status >= 400) {
      throw erroDaRespostaSga(etapa, resposta.status, resposta.data);
    }
    return resposta;
  }
}

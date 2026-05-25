import {
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { BaseOrigin } from '../shared/token-resolver.service';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Timeout padrão para chamadas HTTP à API M7 (em ms) */
const M7_REQUEST_TIMEOUT = 15_000;

/**
 * Mapeamento de credenciais por base de origem.
 * Cada base possui variáveis de ambiente distintas para token e código.
 */
const M7_CREDENTIALS: Record<
  BaseOrigin,
  { tokenEnvVar: string; codigoEnvVar: string }
> = {
  MAIS_PRIME: { tokenEnvVar: 'MO7_TOKEN', codigoEnvVar: 'M07_CODIGO' },
  MAIS_PRIME_RS: { tokenEnvVar: 'MO7_TOKEN_RS', codigoEnvVar: 'M07_CODIGO_RS' },
};

// ---------------------------------------------------------------------------
// Tipos e interfaces
// ---------------------------------------------------------------------------

/** Estado interno do token de autenticação para uma base de origem. */
type TokenState = {
  token: string | null;
  tokenExpires: number | null;
  /** Promise em andamento de renovação, usada como mutex. */
  tokenRenewalPromise: Promise<void> | null;
};

/** Resposta da consulta de última posição do veículo na API M7. */
export interface UltimaPosicaoM7Response {
  monitorado: number;
  data_gps: string;
  latitude: string;
  longitude: string;
  velocidade: number;
  ignicao: boolean;
  cidade: string;
  marca: string;
  modelo: string;
  identificador: string;
}

/**
 * Resposta do endpoint de âncora/ignição da API M7.
 * Retorna os dados atualizados em caso de sucesso ou um objeto de erro.
 */
export type AncoraM7Response =
  | {
      mensagem: string;
      monitorado: number;
      ancora_ativa: number;
      evt_ign: number;
      evg_ign_exec: number;
      ancora_lat: number;
      ancora_lng: number;
    }
  | {
      erro: string;
    };

/** Estado normalizado do evento padrão (âncora + ignição) de um veículo. */
export interface EventoPadraoM7Response {
  ancoraAtiva: boolean;
  evtIgn: boolean;
}

// ---------------------------------------------------------------------------
// Classe principal
// ---------------------------------------------------------------------------

export class RastreamentoM7 {
  private readonly logger = new Logger(RastreamentoM7.name);

  // -------------------------------------------------------------------------
  // Estado interno
  // -------------------------------------------------------------------------

  /** Estado de token por base de origem. */
  private readonly tokenState: Record<BaseOrigin, TokenState> = {
    MAIS_PRIME: { token: null, tokenExpires: null, tokenRenewalPromise: null },
    MAIS_PRIME_RS: {
      token: null,
      tokenExpires: null,
      tokenRenewalPromise: null,
    },
  };

  // -------------------------------------------------------------------------
  // Inicialização
  // -------------------------------------------------------------------------

  constructor() {
    // Obtém tokens para todas as bases ao iniciar a instância
    void this.renovarToken('MAIS_PRIME');
    void this.renovarToken('MAIS_PRIME_RS');

    // Renova tokens a cada 30 minutos de forma contínua.
    // .unref() evita que o intervalo bloqueie o shutdown da aplicação.
    setInterval(() => {
      this.renovarToken('MAIS_PRIME').catch(() => {});
      this.renovarToken('MAIS_PRIME_RS').catch(() => {});
    }, 1800000).unref();
  }

  // -------------------------------------------------------------------------
  // Gerenciamento de token
  // -------------------------------------------------------------------------

  /**
   * Renova o token M7 com mutex — chamadas concorrentes reutilizam
   * a mesma promise de renovação, evitando múltiplos logins simultâneos.
   */
  async renovarToken(baseOrigin: BaseOrigin = 'MAIS_PRIME') {
    const state = this.tokenState[baseOrigin];

    // Se já há uma renovação em andamento, aguarda e reutiliza o resultado
    if (state.tokenRenewalPromise) {
      await state.tokenRenewalPromise;
      return {
        token: state.token,
        expires_in: state.tokenExpires,
      };
    }

    state.tokenRenewalPromise = this.executeRenovarToken(baseOrigin);

    try {
      await state.tokenRenewalPromise;
      return {
        token: state.token,
        expires_in: state.tokenExpires,
      };
    } finally {
      state.tokenRenewalPromise = null;
    }
  }

  /**
   * Executa efetivamente a chamada de login na API M7 e atualiza o estado
   * interno do token para a base informada.
   */
  private async executeRenovarToken(baseOrigin: BaseOrigin): Promise<void> {
    const { tokenEnvVar, codigoEnvVar } = M7_CREDENTIALS[baseOrigin];
    const apiM7Token = process.env[tokenEnvVar];
    const codigo = process.env[codigoEnvVar];

    try {
      const response = await axios.post(
        `${process.env.M7_API_BASE_URL}login`,
        {
          codigo,
          api_m7_token: apiM7Token,
        },
        { timeout: M7_REQUEST_TIMEOUT },
      );

      if (response.data && response.data.sucesso) {
        this.tokenState[baseOrigin].token = response.data.token;
        this.tokenState[baseOrigin].tokenExpires = response.data.expires_in;
        return;
      }

      this.logger.error(
        `[${baseOrigin}] Falha ao renovar token - sucesso=false`,
      );
      throw new InternalServerErrorException('Falha ao renovar token');
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] Erro ao renovar token: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
      );
      throw new InternalServerErrorException('Erro ao renovar token');
    }
  }

  /**
   * Detecta se a resposta indica token expirado ou inválido,
   * tanto por status HTTP 401 quanto por mensagem no body.
   */
  private isTokenError(response: {
    status: number;
    data: Record<string, unknown> | null;
  }): boolean {
    return (
      response.status === 401 ||
      (response.data !== null &&
        typeof response.data === 'object' &&
        typeof response.data.mensagem === 'string' &&
        response.data.mensagem.toLowerCase().includes('token'))
    );
  }

  /**
   * Wrapper genérico: executa o request fornecido e, em caso de token
   * inválido ou expirado, renova e repete a chamada uma única vez.
   *
   * Axios lança AxiosError para respostas HTTP >= 400 (incluindo 401),
   * por isso é necessário capturar a exceção além de checar o body.
   */
  private async executarComReautenticacao<T>(
    baseOrigin: BaseOrigin,
    request: (token: string) => Promise<{ status: number; data: T }>,
  ): Promise<T> {
    const state = this.tokenState[baseOrigin];

    if (!state.token) {
      this.logger.error(
        `[${baseOrigin}] executarComReautenticacao - Token não disponível`,
      );
      throw new InternalServerErrorException('Token não disponível');
    }

    try {
      const response = await request(state.token);
      return response.data;
    } catch (error) {
      // Verifica se o erro é de autenticação e tenta renovar o token
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 ||
          this.isTokenError({
            status: error.response?.status ?? 0,
            data: (error.response?.data as Record<string, unknown>) ?? null,
          }))
      ) {
        this.logger.warn(`[${baseOrigin}] Token expirado/inválido, renovando`);

        await this.renovarToken(baseOrigin);

        if (!state.token) {
          this.logger.error(
            `[${baseOrigin}] Token ainda indisponível após renovação`,
          );
          throw new InternalServerErrorException(
            'Token não disponível após renovação',
          );
        }

        // Retry único com o token renovado
        const retry = await request(state.token);
        return retry.data;
      }

      if (axios.isAxiosError(error)) {
        this.logger.error(
          `[${baseOrigin}] Erro HTTP ${error.response?.status ?? 'sem resposta'}`,
        );
      }

      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Utilitários internos
  // -------------------------------------------------------------------------

  /** Mascara parcialmente um segredo para exibição segura em logs. */
  private maskSecret(value?: string | null): string {
    if (!value) return '(vazio)';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  // -------------------------------------------------------------------------
  // Consultas de veículo
  // -------------------------------------------------------------------------

  /**
   * Consulta a última posição conhecida do veículo na API M7.
   */
  async ultimaPosicaoM7(
    cnpj: string,
    chassi: string,
    baseOrigin: BaseOrigin,
  ): Promise<UltimaPosicaoM7Response> {
    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.post(
          `${process.env.M7_API_BASE_URL}api/veiculos/ultima-posicao`,
          { cnpj, chassi },
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: M7_REQUEST_TIMEOUT,
          },
        ),
      );
      const result = this.mapearUltimaPosicaoM7(
        data as Record<string, unknown>,
      );
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] ultimaPosicaoM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao consultar última posição do veículo',
      );
    }
  }

  /**
   * Busca o estado atual do veículo na API M7 (âncora + ignição).
   * Utilizado como fallback quando o banco não possui o estado registrado.
   */
  async getEventoPadraoM7(
    cnpj: string,
    chassi: string,
    baseOrigin: BaseOrigin,
  ): Promise<EventoPadraoM7Response> {
    try {
      const data = await this.executarComReautenticacao(baseOrigin, (token) =>
        axios.get(`${process.env.M7_API_BASE_URL}api/veiculos/evento-padrao`, {
          params: { cnpj, chassi, scope: 'cliente' },
          headers: { Authorization: `Bearer ${token}` },
          timeout: M7_REQUEST_TIMEOUT,
        }),
      );
      const evento = ((data as Record<string, unknown>).evento ?? {}) as Record<
        string,
        unknown
      >;
      const result = {
        ancoraAtiva: Boolean(evento.ancora),
        evtIgn: Boolean(evento.ignicao_ligada),
      };
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] getEventoPadraoM7 ERRO: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      throw new InternalServerErrorException(
        'Erro ao buscar estado atual do veículo na API M7',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Comandos de veículo (âncora / ignição)
  // -------------------------------------------------------------------------

  /**
   * Envia o payload completo (âncora + ignição) para o endpoint da API M7.
   * Sempre envia ambos os campos para evitar reset acidental de um pelo outro.
   */
  private async _enviarComandoVeiculo(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
    evtIgn: boolean,
    baseOrigin: BaseOrigin,
  ): Promise<AncoraM7Response> {
    const payload = {
      cnpj,
      chassi,
      ancora_ativa: ancoraAtiva,
      evt_ign: evtIgn,
      Envio_mult: true,
    };
    const data = await this.executarComReautenticacao(baseOrigin, (token) =>
      axios.post(`${process.env.M7_API_BASE_URL}api/veiculos/ancora`, payload, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: M7_REQUEST_TIMEOUT,
      }),
    );
    const result = this.mapearAncoraM7(data as Record<string, unknown>);
    return result;
  }

  /**
   * Ativa ou desativa a âncora do veículo.
   * O estado de ignição atual deve ser informado para evitar reset acidental.
   */
  async ancoraM7(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
    evtIgn: boolean,
    baseOrigin: BaseOrigin,
  ): Promise<AncoraM7Response> {
    try {
      const result = await this._enviarComandoVeiculo(
        cnpj,
        chassi,
        ancoraAtiva,
        evtIgn,
        baseOrigin,
      );
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] ancoraM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException('Erro ao atualizar âncora');
    }
  }

  /**
   * Ativa ou desativa a ignição do veículo.
   * O estado de âncora atual deve ser informado para evitar reset acidental.
   */
  async ignicaoM7(
    cnpj: string,
    chassi: string,
    evtIgn: boolean,
    ancoraAtiva: boolean,
    baseOrigin: BaseOrigin,
  ): Promise<AncoraM7Response> {
    try {
      const result = await this._enviarComandoVeiculo(
        cnpj,
        chassi,
        ancoraAtiva,
        evtIgn,
        baseOrigin,
      );
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] ignicaoM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException('Erro ao atualizar ignição');
    }
  }
  // Mapeamento de respostas da API M7
  // -------------------------------------------------------------------------

  /**
   * Converte o payload bruto da API M7 para o formato tipado de última posição.
   */
  private mapearUltimaPosicaoM7(
    data: Record<string, unknown>,
  ): UltimaPosicaoM7Response {
    const ultimaPosicao = (data.ultima_posicao || {}) as Record<
      string,
      unknown
    >;

    return {
      monitorado: ultimaPosicao.monitorado as number,
      data_gps: ultimaPosicao.data_gps as string,
      latitude: ultimaPosicao.latitude as string,
      longitude: ultimaPosicao.longitude as string,
      velocidade: ultimaPosicao.velocidade as number,
      ignicao: ultimaPosicao.ignicao as boolean,
      cidade: ultimaPosicao.cidade as string,
      marca: ultimaPosicao.marca as string,
      modelo: ultimaPosicao.modelo as string,
      identificador: ultimaPosicao.identificador as string,
    };
  }

  /**
   * Converte o payload bruto da API M7 para o formato tipado de âncora.
   * Retorna objeto de erro quando a API sinaliza falha no campo `erro`.
   */
  private mapearAncoraM7(data: Record<string, unknown>): AncoraM7Response {
    if (data && typeof data === 'object' && 'erro' in data) {
      return { erro: (data as { erro: string }).erro };
    }

    const ancora = data;

    return {
      mensagem: ancora.mensagem as string,
      monitorado: ancora.monitorado as number,
      ancora_ativa: ancora.ancora_ativa as number,
      evt_ign: ancora.evt_ign as number,
      evg_ign_exec: ancora.evg_ign_exec as number,
      ancora_lat: ancora.ancora_lat as number,
      ancora_lng: ancora.ancora_lng as number,
    };
  }

  // -------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------

  /**
   * Processa o payload recebido via webhook da API M7.
   * Valida a estrutura básica e retorna um envelope padronizado de resposta.
   */
  processarWebhook(payload: unknown): {
    sucesso: boolean;
    mensagem: string;
    dados?: unknown;
  } {
    const timestamp = new Date().toISOString();

    try {
      if (!payload) {
        return {
          sucesso: false,
          mensagem: 'Payload vazio ou inválido',
        };
      }

      if (typeof payload !== 'object') {
        return {
          sucesso: false,
          mensagem: 'Payload deve ser um objeto JSON válido',
        };
      }

      const payloadData = payload as Record<string, unknown>;
      return {
        sucesso: true,
        mensagem: 'Webhook processado com sucesso',
        dados: {
          palyload: payloadData,
          timestamp_recebimento: timestamp,
        },
      };
    } catch (error) {
      this.logger.error(
        `[M7 Webhook] Erro ao processar webhook: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
      );

      return {
        sucesso: false,
        mensagem: 'Erro ao processar webhook',
        dados: {
          erro: error instanceof Error ? error.message : 'Erro desconhecido',
          timestamp_erro: timestamp,
        },
      };
    }
  }
}

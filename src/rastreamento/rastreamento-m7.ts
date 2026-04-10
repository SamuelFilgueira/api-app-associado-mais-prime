import { InternalServerErrorException, Logger } from '@nestjs/common';
import axios from 'axios';
import { BaseOrigin } from '../shared/token-resolver.service';

/** Timeout padrão para chamadas HTTP à API M7 (em ms) */
const M7_REQUEST_TIMEOUT = 15_000;

const M7_CREDENTIALS: Record<
  BaseOrigin,
  { tokenEnvVar: string; codigoEnvVar: string }
> = {
  MAIS_PRIME: { tokenEnvVar: 'MO7_TOKEN', codigoEnvVar: 'M07_CODIGO' },
  MAIS_PRIME_RS: { tokenEnvVar: 'MO7_TOKEN_RS', codigoEnvVar: 'M07_CODIGO_RS' },
};

type TokenState = {
  token: string | null;
  tokenExpires: number | null;
  tokenRenewalPromise: Promise<void> | null;
};

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

export interface EventoPadraoM7Response {
  ancoraAtiva: boolean;
  evtIgn: boolean;
}

export class RastreamentoM7 {
  private readonly logger = new Logger(RastreamentoM7.name);

  private maskSecret(value?: string | null): string {
    if (!value) return '(vazio)';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  /** Estado de token por base */
  private readonly tokenState: Record<BaseOrigin, TokenState> = {
    MAIS_PRIME: { token: null, tokenExpires: null, tokenRenewalPromise: null },
    MAIS_PRIME_RS: {
      token: null,
      tokenExpires: null,
      tokenRenewalPromise: null,
    },
  };

  constructor() {
    // Renovar tokens para todas as bases ao iniciar
    void this.renovarToken('MAIS_PRIME');
    void this.renovarToken('MAIS_PRIME_RS');
    setInterval(() => {
      this.renovarToken('MAIS_PRIME').catch(() => {});
      this.renovarToken('MAIS_PRIME_RS').catch(() => {});
    }, 1800000).unref(); // unref para não bloquear shutdown
  }

  /**
   * Detecta se a resposta indica token expirado/inválido.
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
   * Wrapper genérico: executa request, e em caso de token inválido
   * renova e faz retry uma única vez.
   *
   * Axios lança AxiosError para respostas HTTP >= 400 (incluindo 401),
   * por isso é necessário capturar a exceção aqui além de checar o body.
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
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 ||
          this.isTokenError({
            status: error.response?.status ?? 0,
            data: (error.response?.data as Record<string, unknown>) ?? null,
          }))
      ) {
        this.logger.warn(
          `[${baseOrigin}] Token expirado/inválido, renovando`,
        );

        await this.renovarToken(baseOrigin);

        if (!state.token) {
          this.logger.error(
            `[${baseOrigin}] Token ainda indisponível após renovação`,
          );
          throw new InternalServerErrorException(
            'Token não disponível após renovação',
          );
        }

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

  /**
   * Busca o estado atual do veículo na API M7 (âncora + ignição).
   * Usado como fallback quando o banco não possui o estado.
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
          headers: {
            Authorization: `Bearer ${token}`,
          },
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

  /**
   * Envia o payload completo (âncora + ignição) para o endpoint da API M7.
   * Sempre envia ambos os campos para evitar que um reset acidental do outro.
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
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: M7_REQUEST_TIMEOUT,
      }),
    );
    const result = this.mapearAncoraM7(data as Record<string, unknown>);
    return result;
  }

  // Consultar a última posição do veículo via M7
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
            headers: {
              Authorization: `Bearer ${token}`,
            },
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

  /**
   * Renova o token M7 com mutex — chamadas concorrentes reutilizam
   * a mesma promise de renovação, evitando múltiplos logins simultâneos.
   */
  async renovarToken(baseOrigin: BaseOrigin = 'MAIS_PRIME') {
    const state = this.tokenState[baseOrigin];
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

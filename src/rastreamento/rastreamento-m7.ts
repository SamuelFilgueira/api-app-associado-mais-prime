import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import axios from 'axios';
import { BaseOrigin, TokenResolverService } from '../shared/token-resolver.service';
import { mapTenantBases, TENANT } from '../config/tenant.config';
import { M7ReverseGeocodeService } from './m7/services/m7-reverse-geocode.service';
import {
  IRastreamentoProvider,
  RastreamentoBaseContext,
  RastreamentoCandidatoResult,
} from './providers/rastreamento-provider.interface';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Timeout padrão para chamadas HTTP à API M7 (em ms) */
const M7_REQUEST_TIMEOUT = 15_000;
const M7_REV_GEOCODE_TIMEOUT_MS = Number(
  process.env.M7_REV_GEOCODE_TIMEOUT_MS ?? 900,
);

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
  tensao?: string | null;
  voltagem?: number | null;
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

@Injectable()
export class RastreamentoM7 implements IRastreamentoProvider, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RastreamentoM7.name);
  readonly providerName = 'm7' as const;

  // -------------------------------------------------------------------------
  // Estado interno
  // -------------------------------------------------------------------------

  private readonly bases: BaseOrigin[] = TENANT.baseNames;

  /** Estado de token por base de origem. */
  private readonly tokenState: Record<BaseOrigin, TokenState> = mapTenantBases(
    () => ({ token: null, tokenExpires: null, tokenRenewalPromise: null }),
  );

  private renewalInterval: NodeJS.Timeout;

  // -------------------------------------------------------------------------
  // Inicialização
  // -------------------------------------------------------------------------

  constructor(
    private readonly tokenResolver: TokenResolverService,
    private readonly reverseGeocodeService: M7ReverseGeocodeService,
  ) {}

  private async obterEnderecoLocalPorCoordenadas(
    latitude: string,
    longitude: string,
    baseOrigin: BaseOrigin,
    cidadeFallback?: string,
  ): Promise<string | null> {
    const lat = this.reverseGeocodeService.normalizarCoordenada(latitude);
    const lon = this.reverseGeocodeService.normalizarCoordenada(longitude);

    if (!lat || !lon) {
      return null;
    }

    const timeoutMs = Number.isFinite(M7_REV_GEOCODE_TIMEOUT_MS)
      ? Math.max(100, M7_REV_GEOCODE_TIMEOUT_MS)
      : 900;

    const cidadeNormalizada = this.reverseGeocodeService.normalizarCidadeM7(
      cidadeFallback,
    );

    try {
      const endereco = await Promise.race<string | null>([
        this.reverseGeocodeService.reverseGeocodeCoordenada(
          lat,
          lon,
          baseOrigin,
          cidadeNormalizada ?? undefined,
        ),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);

      if (!endereco || endereco === `${lat}, ${lon}`) {
        return null;
      }

      return endereco;
    } catch (error) {
      this.logger.warn(
        `[${baseOrigin}] Falha no reverse geocode M7 (${lat},${lon}): ${
          error instanceof Error ? error.message : 'erro desconhecido'
        }`,
      );
      return null;
    }
  }

  async onModuleInit(): Promise<void> {
    await Promise.allSettled(this.bases.map((b) => this.renovarToken(b)));

    this.renewalInterval = setInterval(() => {
      for (const base of this.bases) {
        void this.renovarToken(base).catch(() => {});
      }
    }, 1_800_000);
    this.renewalInterval.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.renewalInterval);
  }

  // -------------------------------------------------------------------------
  // IRastreamentoProvider
  // -------------------------------------------------------------------------

  async obterUltimaPosicao(params: {
    cnpj: string;
    chassi: string;
    baseContext: RastreamentoBaseContext;
  }): Promise<RastreamentoCandidatoResult> {
    const { cnpj, chassi, baseContext } = params;
    const data = await this.ultimaPosicaoM7(cnpj, chassi, baseContext.baseOrigin);
    return {
      dataOriginal: data.data_gps,
      timestamp: new Date(data.data_gps.replace(' ', 'T')).getTime(),
      data: data as unknown as Record<string, unknown>,
      origem: 'm7',
    };
  }

  // -------------------------------------------------------------------------
  // Gerenciamento de token
  // -------------------------------------------------------------------------

  /**
   * Renova o token M7 com mutex — chamadas concorrentes reutilizam
   * a mesma promise de renovação, evitando múltiplos logins simultâneos.
   */
  async renovarToken(baseOrigin: BaseOrigin = TENANT.defaultBase) {
    const state = this.tokenState[baseOrigin];

    if (state.tokenRenewalPromise) {
      await state.tokenRenewalPromise;
      return { token: state.token, expires_in: state.tokenExpires };
    }

    state.tokenRenewalPromise = this.executeRenovarToken(baseOrigin);

    try {
      await state.tokenRenewalPromise;
      return { token: state.token, expires_in: state.tokenExpires };
    } finally {
      state.tokenRenewalPromise = null;
    }
  }

  /**
   * Executa efetivamente a chamada de login na API M7 e atualiza o estado
   * interno do token para a base informada.
   */
  private async executeRenovarToken(baseOrigin: BaseOrigin): Promise<void> {
    const apiM7Token = process.env[this.tokenResolver.getTokenKey(baseOrigin, 'm7Token')];
    const codigo = process.env[this.tokenResolver.getTokenKey(baseOrigin, 'm7Codigo')];

    try {
      const response = await axios.post(
        `${process.env.M7_API_BASE_URL}login`,
        { codigo, api_m7_token: apiM7Token },
        { timeout: M7_REQUEST_TIMEOUT },
      );

      if (response.data && response.data.sucesso) {
        this.tokenState[baseOrigin].token = response.data.token;
        this.tokenState[baseOrigin].tokenExpires = response.data.expires_in;
        return;
      }

      this.logger.error(`[${baseOrigin}] Falha ao renovar token - sucesso=false`);
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
   */
  private async executarComReautenticacao<T>(
    baseOrigin: BaseOrigin,
    request: (token: string) => Promise<{ status: number; data: T }>,
  ): Promise<T> {
    const state = this.tokenState[baseOrigin];

    if (!state.token) {
      this.logger.error(`[${baseOrigin}] executarComReautenticacao - Token não disponível`);
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
        this.logger.warn(`[${baseOrigin}] Token expirado/inválido, renovando`);
        await this.renovarToken(baseOrigin);

        if (!state.token) {
          this.logger.error(`[${baseOrigin}] Token ainda indisponível após renovação`);
          throw new InternalServerErrorException('Token não disponível após renovação');
        }

        const retry = await request(state.token);
        return retry.data;
      }

      if (axios.isAxiosError(error)) {
        const responseBody = error.response?.data;
        this.logger.error(
          `[${baseOrigin}] Erro HTTP ${error.response?.status ?? 'sem resposta'} | url=${error.config?.url ?? 'N/A'} | body=${JSON.stringify(responseBody ?? null)}`,
        );
      }

      throw error;
    }
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
  reverseGeocode: boolean = true,
): Promise<UltimaPosicaoM7Response> {
  try {
    this.logger.debug(`[${baseOrigin}] Consultando última posição M7 para chassi=${chassi}`);
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
    this.logger.debug(`[${baseOrigin}] Resposta recebida da M7 para chassi=${chassi}: ${JSON.stringify(data)}`);

    const raw = (data as Record<string, unknown>).ultima_posicao as Record<string, unknown> || {};
    const latitude = raw.latitude as string;
    const longitude = raw.longitude as string;
    const cidadeFallback = raw.cidade as string | undefined;

    let endereco: string | null | undefined;
    if (reverseGeocode) {
      endereco = await this.obterEnderecoLocalPorCoordenadas(
        latitude,
        longitude,
        baseOrigin,
        cidadeFallback,
      );
    }

    const ultimaPosicaoMapeada = this.mapearUltimaPosicaoM7(
      data as Record<string, unknown>,
      endereco ?? undefined,
    );

    return ultimaPosicaoMapeada;
  } catch (error) {
    if (error instanceof InternalServerErrorException) throw error;
    this.logger.error(
      `[${baseOrigin}] ultimaPosicaoM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
    throw new InternalServerErrorException('Erro ao consultar última posição do veículo');
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
      const evento = ((data as Record<string, unknown>).evento ?? {}) as Record<string, unknown>;
      return {
        ancoraAtiva: Boolean(evento.ancora),
        evtIgn: Boolean(evento.ignicao_ligada),
      };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `[${baseOrigin}] getEventoPadraoM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException('Erro ao buscar estado atual do veículo na API M7');
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
    return this.mapearAncoraM7(data as Record<string, unknown>);
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
      return await this._enviarComandoVeiculo(cnpj, chassi, ancoraAtiva, evtIgn, baseOrigin);
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      const upstreamMessage = this.extractM7ErrorMessage(error);

      if (axios.isAxiosError(error) && error.response?.status === 404 && upstreamMessage) {
        throw new BadRequestException(`M7 rejeitou atualização da âncora: ${upstreamMessage}`);
      }

      this.logger.error(
        `[${baseOrigin}] ancoraM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}${upstreamMessage ? ` | upstream=${upstreamMessage}` : ''}`,
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
      return await this._enviarComandoVeiculo(cnpj, chassi, ancoraAtiva, evtIgn, baseOrigin);
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      const upstreamMessage = this.extractM7ErrorMessage(error);

      if (axios.isAxiosError(error) && error.response?.status === 404 && upstreamMessage) {
        throw new BadRequestException(`M7 rejeitou atualização da ignição: ${upstreamMessage}`);
      }

      this.logger.error(
        `[${baseOrigin}] ignicaoM7 ERRO: ${error instanceof Error ? error.message : JSON.stringify(error)}${upstreamMessage ? ` | upstream=${upstreamMessage}` : ''}`,
      );
      throw new InternalServerErrorException('Erro ao atualizar ignição');
    }
  }

  private extractM7ErrorMessage(error: unknown): string | null {
    if (!axios.isAxiosError(error)) {
      return null;
    }

    const data = error.response?.data;
    if (!data || typeof data !== 'object') {
      return null;
    }

    const erro = (data as Record<string, unknown>).erro;
    if (typeof erro === 'string' && erro.trim().length > 0) {
      return erro.trim();
    }

    const mensagem = (data as Record<string, unknown>).mensagem;
    if (typeof mensagem === 'string' && mensagem.trim().length > 0) {
      return mensagem.trim();
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Mapeamento de respostas da API M7
  // -------------------------------------------------------------------------

  /**
   * Converte o payload bruto da API M7 para o formato tipado de última posição.
   */
  private mapearUltimaPosicaoM7(
  data: Record<string, unknown>,
  endereco?: string, // novo parâmetro opcional
): UltimaPosicaoM7Response {
  const ultimaPosicao = (data.ultima_posicao || {}) as Record<string, unknown>;
  const tensaoRaw = ultimaPosicao.tensao;
  const voltagemFromTensao =
    typeof tensaoRaw === 'number'
      ? tensaoRaw
      : typeof tensaoRaw === 'string'
        ? Number.parseFloat(tensaoRaw.replace(',', '.'))
        : Number.NaN;

  return {
    monitorado: ultimaPosicao.monitorado as number,
    data_gps: ultimaPosicao.data_gps as string,
    latitude: ultimaPosicao.latitude as string,
    longitude: ultimaPosicao.longitude as string,
    velocidade: ultimaPosicao.velocidade as number,
    tensao:
      typeof tensaoRaw === 'string' || typeof tensaoRaw === 'number'
        ? String(tensaoRaw)
        : null,
    voltagem: Number.isFinite(voltagemFromTensao) ? voltagemFromTensao : null,
    ignicao: ultimaPosicao.ignicao as boolean,
    // Usa o endereço se fornecido, senão usa o valor original
    cidade: endereco ?? (ultimaPosicao.cidade as string),
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

    return {
      mensagem: data.mensagem as string,
      monitorado: data.monitorado as number,
      ancora_ativa: data.ancora_ativa as number,
      evt_ign: data.evt_ign as number,
      evg_ign_exec: data.evg_ign_exec as number,
      ancora_lat: data.ancora_lat as number,
      ancora_lng: data.ancora_lng as number,
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
        return { sucesso: false, mensagem: 'Payload vazio ou inválido' };
      }

      if (typeof payload !== 'object') {
        return { sucesso: false, mensagem: 'Payload deve ser um objeto JSON válido' };
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

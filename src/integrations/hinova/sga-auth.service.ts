import { SGA_BASE_URL } from './hinova.constants';
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  BaseOrigin,
  TokenResolverService,
} from 'src/shared/token-resolver.service';
import { baseTag } from 'src/shared/log.util';

interface SgaAuthResponse {
  mensagem: string;
  token_usuario?: string;
}

/**
 * Pausa mínima entre tentativas de login após uma falha (qualquer motivo).
 *
 * Sem ela, cada requisição que chega enquanto o login está falhando dispara
 * um novo `POST /usuario/autenticar`: com o app em uso, são dezenas de logins
 * por minuto contra um token que a Hinova já recusou. Esse é exatamente o
 * "excesso de requisições em período curto" que a Hinova bloqueia — e que
 * prolonga o próprio bloqueio.
 */
export const SGA_AUTH_COOLDOWN_FALHA_MS = 15_000;

/**
 * Pausa quando TODOS os tokens de base da base estão bloqueados pela Hinova.
 * O desbloqueio é automático (~1h, segundo a Hinova): sondar 1x por minuto
 * basta para retomar assim que liberar, sem insistir.
 */
export const SGA_AUTH_COOLDOWN_BLOQUEIO_MS = 60_000;

export interface SgaRequestOptions {
  /**
   * Quando a Hinova responde o 403 de bloqueio, alternar para o próximo token
   * de base e repetir a requisição (default `true`).
   *
   * Rotinas de varredura (paginação em massa) devem passar `false`: se a
   * varredura bloqueou o token ativo, continuar com o token reserva só
   * queimaria também o reserva — que é o que mantém o app funcionando.
   */
  failoverTokenBase?: boolean;
}

/**
 * Falha de autenticação no SGA. `bloqueioTotal` indica que todos os tokens de
 * base configurados foram recusados com o 403 de bloqueio da Hinova.
 */
export class FalhaAutenticacaoSga extends Error {
  constructor(
    message: string,
    readonly bloqueioTotal: boolean,
  ) {
    super(message);
    this.name = 'FalhaAutenticacaoSga';
  }
}

/**
 * Identifica o bloqueio temporário da Hinova por "extração de dados":
 * HTTP 403 com corpo do tipo
 * `{"mensagem":"Forbidden","error":["Token BLOQUEADO temporariamente por excesso de extracao de DADOS..."]}`.
 * Só esse caso dispara o failover de token de base; outros 403 seguem como antes.
 */
export function ehBloqueioPorExtracao(status: number, data: unknown): boolean {
  if (status !== 403 || data === null || data === undefined) return false;
  const texto = (typeof data === 'string' ? data : JSON.stringify(data))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return texto.includes('bloqueado') && texto.includes('extracao');
}

@Injectable()
export class SgaAuthService {
  private readonly logger = new Logger(SgaAuthService.name);
  private readonly userTokenCache = new Map<BaseOrigin, string>();
  private readonly authInFlight = new Map<BaseOrigin, Promise<string>>();
  /**
   * Índice do token de base em uso por base (ver
   * `TokenResolverService.resolveSgaBaseTokens`). Quando a Hinova bloqueia o
   * token ativo, avança para o próximo e permanece nele ("sticky") até que
   * este também seja bloqueado.
   */
  private readonly indiceTokenBase = new Map<BaseOrigin, number>();
  /**
   * Pausa de login por base após uma falha: até `ate`, `getUserToken` falha
   * imediatamente, sem chamar `/usuario/autenticar`.
   */
  private readonly authCooldown = new Map<
    BaseOrigin,
    { ate: number; motivo: string }
  >();

  constructor(private readonly tokenResolver: TokenResolverService) {}

  async getUserToken(
    baseOrigin: BaseOrigin,
    forceRefresh = false,
  ): Promise<string> {
    if (!forceRefresh) {
      const cached = this.userTokenCache.get(baseOrigin);
      if (cached) {
        return cached;
      }
    }

    const inFlight = this.authInFlight.get(baseOrigin);
    if (inFlight) {
      return inFlight;
    }

    const cooldown = this.authCooldown.get(baseOrigin);
    if (cooldown && cooldown.ate > Date.now()) {
      const restanteSeg = Math.ceil((cooldown.ate - Date.now()) / 1000);
      throw new FalhaAutenticacaoSga(
        `Falha ao autenticar no SGA para base ${baseOrigin}: ${cooldown.motivo}; nova tentativa de login em ${restanteSeg}s`,
        false,
      );
    }

    const authPromise = this.authenticate(baseOrigin)
      .then((token) => {
        this.userTokenCache.set(baseOrigin, token);
        this.authCooldown.delete(baseOrigin);
        return token;
      })
      .catch((err: unknown) => {
        this.registrarCooldown(baseOrigin, err);
        throw err;
      })
      .finally(() => {
        this.authInFlight.delete(baseOrigin);
      });

    this.authInFlight.set(baseOrigin, authPromise);
    return authPromise;
  }

  invalidateUserToken(baseOrigin: BaseOrigin): void {
    this.userTokenCache.delete(baseOrigin);
  }

  /** Token de base ativo (para diagnóstico/log). */
  tokenBaseAtivo(baseOrigin: BaseOrigin): {
    indice: number;
    total: number;
  } {
    const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;
    return { indice: this.indiceTokenBase.get(baseOrigin) ?? 0, total };
  }

  async executeWithAuth<T>(
    baseOrigin: BaseOrigin,
    makeRequest: (tokenUsuario: string) => Promise<AxiosResponse<T>>,
    opcoes?: SgaRequestOptions,
  ): Promise<AxiosResponse<T>> {
    let tokenUsuario = await this.getUserToken(baseOrigin);
    let response = await makeRequest(tokenUsuario);

    if (ehBloqueioPorExtracao(response.status, response.data)) {
      const totalTokens =
        this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;
      const anterior = this.indiceTokenBase.get(baseOrigin) ?? 0;

      // Failover desativado pelo chamador (varreduras): devolve o 403 e
      // preserva o token reserva para o tráfego do app.
      if (opcoes?.failoverTokenBase === false) {
        if (totalTokens > 1) {
          this.logger.warn(
            `${baseTag(baseOrigin)} token de base #${anterior + 1} BLOQUEADO pela Hinova (extração de dados). Failover desativado para esta requisição — token reserva preservado.`,
          );
        }
        return response;
      }

      // Bloqueio por extração de dados no token de base ativo: troca de token de
      // base, reautentica e repete UMA vez. Só quando há mais de um token
      // configurado — com um único token o comportamento é o de sempre.
      // A repetição é segura: a Hinova recusou a requisição sem processá-la.
      if (totalTokens > 1) {
        this.logger.warn(
          `${baseTag(baseOrigin)} token de base #${anterior + 1} BLOQUEADO pela Hinova (extração de dados). Alternando para o próximo token e repetindo a requisição.`,
        );
        this.avancarTokenBase(baseOrigin);
        this.invalidateUserToken(baseOrigin);
        tokenUsuario = await this.getUserToken(baseOrigin, true);
        return makeRequest(tokenUsuario);
      }
    }

    if (response.status !== 401) {
      return response;
    }

    this.logger.warn(
      `${baseTag(baseOrigin)} token_usuario inválido. Reautenticando automaticamente.`,
    );
    this.invalidateUserToken(baseOrigin);
    tokenUsuario = await this.getUserToken(baseOrigin, true);
    response = await makeRequest(tokenUsuario);
    return response;
  }

  async executeRequestWithAuth<T>(
    baseOrigin: BaseOrigin,
    config: Omit<AxiosRequestConfig, 'headers'> & {
      headers?: Record<string, string>;
    } & SgaRequestOptions,
  ): Promise<AxiosResponse<T>> {
    const { failoverTokenBase, ...axiosConfig } = config;
    return this.executeWithAuth(
      baseOrigin,
      (tokenUsuario) =>
        axios.request<T>({
          ...axiosConfig,
          headers: {
            ...(axiosConfig.headers ?? {}),
            Authorization: `Bearer ${tokenUsuario}`,
          },
          validateStatus: axiosConfig.validateStatus ?? (() => true),
        }),
      { failoverTokenBase },
    );
  }

  private avancarTokenBase(baseOrigin: BaseOrigin): number {
    const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;
    const proximo = ((this.indiceTokenBase.get(baseOrigin) ?? 0) + 1) % total;
    this.indiceTokenBase.set(baseOrigin, proximo);
    return proximo;
  }

  /**
   * Registra a pausa de login da base após uma falha. Bloqueio total pela
   * Hinova pausa por mais tempo (o desbloqueio é automático e demora);
   * qualquer outra falha (5xx, rede, credencial) pausa o suficiente para não
   * repetir o login a cada requisição que chega.
   */
  private registrarCooldown(baseOrigin: BaseOrigin, err: unknown): void {
    const bloqueio = err instanceof FalhaAutenticacaoSga && err.bloqueioTotal;
    const duracaoMs = bloqueio
      ? SGA_AUTH_COOLDOWN_BLOQUEIO_MS
      : SGA_AUTH_COOLDOWN_FALHA_MS;
    const motivo = bloqueio
      ? 'todos os tokens de base estão bloqueados pela Hinova'
      : 'último login no SGA falhou';

    this.authCooldown.set(baseOrigin, {
      ate: Date.now() + duracaoMs,
      motivo,
    });
    this.logger.warn(
      `${baseTag(baseOrigin)} login no SGA em pausa por ${duracaoMs / 1000}s (${motivo}). Requisições nesse intervalo falham sem chamar a Hinova.`,
    );
  }

  /**
   * Autentica no SGA com o token de base ativo. Se a Hinova responder o
   * bloqueio por extração de dados, tenta o próximo token de base (uma volta
   * completa, no máximo). Qualquer outra falha mantém o tratamento original.
   */
  private async authenticate(baseOrigin: BaseOrigin): Promise<string> {
    const user = this.tokenResolver.resolveSgaUser(baseOrigin);
    const password = this.tokenResolver.resolveSgaPassword(baseOrigin);
    const tokensBase = this.tokenResolver.resolveSgaBaseTokens(baseOrigin);

    let indice = this.indiceTokenBase.get(baseOrigin) ?? 0;
    if (indice >= tokensBase.length) indice = 0;

    for (let tentativa = 0; tentativa < tokensBase.length; tentativa++) {
      const response = await axios.post<SgaAuthResponse>(
        `${SGA_BASE_URL}/usuario/autenticar`,
        { usuario: user, senha: password },
        {
          headers: {
            Authorization: `Bearer ${tokensBase[indice]}`,
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
        },
      );

      if (response.status < 400 && response.data?.token_usuario) {
        this.indiceTokenBase.set(baseOrigin, indice);
        return response.data.token_usuario;
      }

      const bloqueado = ehBloqueioPorExtracao(response.status, response.data);

      if (
        bloqueado &&
        tokensBase.length > 1 &&
        tentativa < tokensBase.length - 1
      ) {
        this.logger.warn(
          `${baseTag(baseOrigin)} token de base #${indice + 1}/${tokensBase.length} BLOQUEADO pela Hinova na autenticação (extração de dados). Tentando o próximo.`,
        );
        indice = (indice + 1) % tokensBase.length;
        this.indiceTokenBase.set(baseOrigin, indice);
        continue;
      }

      this.logger.error(
        `${baseTag(baseOrigin)} falha na autenticação SGA (token de base #${indice + 1}/${tokensBase.length}): status=${response.status} body=${JSON.stringify(response.data)}`,
      );
      throw new FalhaAutenticacaoSga(
        `Falha ao autenticar no SGA para base ${baseOrigin}`,
        bloqueado,
      );
    }

    throw new FalhaAutenticacaoSga(
      `Falha ao autenticar no SGA para base ${baseOrigin}`,
      false,
    );
  }
}

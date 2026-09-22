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

    const authPromise = this.authenticate(baseOrigin)
      .then((token) => {
        this.userTokenCache.set(baseOrigin, token);
        return token;
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
  ): Promise<AxiosResponse<T>> {
    let tokenUsuario = await this.getUserToken(baseOrigin);
    let response = await makeRequest(tokenUsuario);

    // Bloqueio por extração de dados no token de base ativo: troca de token de
    // base, reautentica e repete UMA vez. Só quando há mais de um token
    // configurado — com um único token o comportamento é o de sempre.
    // A repetição é segura: a Hinova recusou a requisição sem processá-la.
    if (
      ehBloqueioPorExtracao(response.status, response.data) &&
      this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length > 1
    ) {
      const anterior = this.indiceTokenBase.get(baseOrigin) ?? 0;
      this.logger.warn(
        `${baseTag(baseOrigin)} token de base #${anterior + 1} BLOQUEADO pela Hinova (extração de dados). Alternando para o próximo token e repetindo a requisição.`,
      );
      this.avancarTokenBase(baseOrigin);
      this.invalidateUserToken(baseOrigin);
      tokenUsuario = await this.getUserToken(baseOrigin, true);
      return makeRequest(tokenUsuario);
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
    },
  ): Promise<AxiosResponse<T>> {
    return this.executeWithAuth(baseOrigin, (tokenUsuario) =>
      axios.request<T>({
        ...config,
        headers: {
          ...(config.headers ?? {}),
          Authorization: `Bearer ${tokenUsuario}`,
        },
        validateStatus: config.validateStatus ?? (() => true),
      }),
    );
  }

  private avancarTokenBase(baseOrigin: BaseOrigin): number {
    const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;
    const proximo = ((this.indiceTokenBase.get(baseOrigin) ?? 0) + 1) % total;
    this.indiceTokenBase.set(baseOrigin, proximo);
    return proximo;
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

      const bloqueado =
        tokensBase.length > 1 &&
        ehBloqueioPorExtracao(response.status, response.data);

      if (bloqueado && tentativa < tokensBase.length - 1) {
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
      throw new Error(`Falha ao autenticar no SGA para base ${baseOrigin}`);
    }

    throw new Error(`Falha ao autenticar no SGA para base ${baseOrigin}`);
  }
}

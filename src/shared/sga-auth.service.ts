import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseOrigin, SgaAuthCredentials, TokenResolverService } from './token-resolver.service';
import { baseTag } from './log.util';

interface SgaAuthResponse {
  mensagem: string;
  token_usuario?: string;
}

@Injectable()
export class SgaAuthService {
  private readonly logger = new Logger(SgaAuthService.name);
  private readonly userTokenCache = new Map<BaseOrigin, string>();
  private readonly authInFlight = new Map<BaseOrigin, Promise<string>>();

  constructor(private readonly tokenResolver: TokenResolverService) {}

  async getUserToken(baseOrigin: BaseOrigin, forceRefresh = false): Promise<string> {
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

  async executeWithAuth<T>(
    baseOrigin: BaseOrigin,
    makeRequest: (tokenUsuario: string) => Promise<AxiosResponse<T>>,
  ): Promise<AxiosResponse<T>> {
    let tokenUsuario = await this.getUserToken(baseOrigin);
    let response = await makeRequest(tokenUsuario);

    if (response.status !== 401) {
      return response;
    }

    this.logger.warn(`${baseTag(baseOrigin)} token_usuario inválido. Reautenticando automaticamente.`);
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

  private async authenticate(baseOrigin: BaseOrigin): Promise<string> {
    const credentials: SgaAuthCredentials =
      this.tokenResolver.resolveSgaAuthCredentials(baseOrigin);

    this.logger.log(`${baseTag(baseOrigin)} autenticando usuário SGA`);

    const response = await axios.post<SgaAuthResponse>(
      'https://api.hinova.com.br/api/sga/v2/usuario/autenticar',
      {
        usuario: credentials.user,
        senha: credentials.password,
      },
      {
        headers: {
          Authorization: `Bearer ${credentials.baseToken}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      },
    );

    if (response.status >= 400 || !response.data?.token_usuario) {
      this.logger.error(
        `${baseTag(baseOrigin)} falha na autenticação SGA: status=${response.status} body=${JSON.stringify(response.data)}`,
      );
      throw new Error(`Falha ao autenticar no SGA para base ${baseOrigin}`);
    }

    return response.data.token_usuario;
  }
}

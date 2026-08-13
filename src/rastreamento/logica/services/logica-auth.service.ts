import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { maskSecret } from 'src/shared/log.util';

const LOGICA_REQUEST_TIMEOUT = 15_000;

/**
 * Backoff entre tentativas de login no /autentica. A Lógica recusa logins em
 * rajada (HTTP 200 com erro=true e token vazio) e libera após alguns
 * segundos — observado em produção: 3 recusas espaçadas ~2-3s e sucesso ~10s
 * após a primeira. O espaçamento crescente atravessa essa janela de throttle.
 */
const LOGICA_AUTH_BACKOFF_MS = [2_000, 4_000, 6_000];

const aguardar = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LogicaAuthResponse {
  erro?: boolean;
  logado?: boolean;
  token?: string;
  mensagem?: string;
}

/**
 * Sessão ÚNICA da Lógica para toda a aplicação (mesmo papel do
 * SgaAuthService para a Hinova).
 *
 * A Lógica autentica com uma credencial só (LOGICA_API_NUMBER) e cada login
 * novo invalida/compete com a sessão anterior. Antes desta classe, o
 * rastreamento em tempo real (LogicaRastreamentoService) e o histórico
 * (TrajetosService) mantinham caches de token separados e faziam logins
 * independentes — o token renovado por um fluxo não era visto pelo outro,
 * gerando logins redundantes em sequência, que é exatamente o que o
 * throttle do /autentica recusa. Centralizando aqui, um token renovado por
 * qualquer fluxo vale para todos.
 */
@Injectable()
export class LogicaAuthService {
  private readonly logger = new Logger(LogicaAuthService.name);

  /** Token de sessão por base (em memória; renovado sob demanda) */
  private readonly tokenCache = new Map<string, string>();

  /**
   * Autenticações em voo por base (dedupe): chamadas paralelas que detectam
   * token inválido ao mesmo tempo compartilham UM único login em vez de
   * disparar logins simultâneos — que é justamente o que o throttle da
   * Lógica recusa.
   */
  private readonly authEmVoo = new Map<string, Promise<string>>();

  /**
   * Token para a PRIMEIRA tentativa de uma chamada: o cacheado (renovado por
   * qualquer fluxo), senão o informado pelo chamador, senão o LOGICA_TOKEN
   * do env. Se a API recusar, o chamador deve pedir renovarToken().
   */
  obterTokenInicial(baseOrigin?: string, tokenFallback?: string): string {
    const cacheKey = baseOrigin ?? 'default';
    const usedToken =
      this.tokenCache.get(cacheKey) ?? tokenFallback ?? process.env.LOGICA_TOKEN;

    if (!usedToken) {
      this.logger.error('LOGICA token não fornecido nem presente em env');
      throw new InternalServerErrorException(
        'LOGICA_TOKEN não definido nas variáveis de ambiente',
      );
    }

    return usedToken;
  }

  /**
   * Autentica na Lógica com dedupe em voo por base: se já existe um login em
   * andamento para a mesma base, aguarda o resultado dele em vez de disparar
   * outro. O login em si tem retry com backoff (ver autenticarComRetry).
   */
  renovarToken(baseOrigin?: string): Promise<string> {
    const cacheKey = baseOrigin ?? 'default';

    const emVoo = this.authEmVoo.get(cacheKey);
    if (emVoo) {
      return emVoo;
    }

    const promessa = this.autenticarComRetry(baseOrigin)
      .then((token) => {
        this.tokenCache.set(cacheKey, token);
        this.logger.log(
          `Token da Lógica renovado com sucesso baseOrigin=${baseOrigin ?? 'N/A'} token=${maskSecret(token)}`,
        );
        return token;
      })
      .finally(() => {
        this.authEmVoo.delete(cacheKey);
      });

    this.authEmVoo.set(cacheKey, promessa);
    return promessa;
  }

  /**
   * Tenta o login no /autentica até esgotar o backoff. A recusa da Lógica é
   * transitória (throttle de logins em rajada): vem HTTP 200 com erro=true,
   * logado=false e token vazio, sem mensagem — reaguardar e repetir resolve.
   */
  private async autenticarComRetry(baseOrigin?: string): Promise<string> {
    // Erro de configuração não é transitório — falha antes de qualquer retry
    const apiNumber = process.env.LOGICA_API_NUMBER;
    if (!apiNumber) {
      throw new InternalServerErrorException(
        'LOGICA_API_NUMBER não definido nas variáveis de ambiente',
      );
    }

    const totalTentativas = LOGICA_AUTH_BACKOFF_MS.length + 1;
    let ultimoDetalhe = 'sem detalhe';

    for (let tentativa = 1; tentativa <= totalTentativas; tentativa++) {
      if (tentativa > 1) {
        await aguardar(LOGICA_AUTH_BACKOFF_MS[tentativa - 2]);
      }

      try {
        const token = await this.executarAutenticacao(apiNumber);
        if (token) {
          return token;
        }
        ultimoDetalhe = 'login recusado pela Lógica (erro=true/token vazio)';
      } catch (error) {
        ultimoDetalhe = error instanceof Error ? error.message : String(error);
      }

      if (tentativa < totalTentativas) {
        this.logger.warn(
          `Autenticação na Lógica recusada (tentativa ${tentativa}/${totalTentativas}) baseOrigin=${baseOrigin ?? 'N/A'}: ${ultimoDetalhe}. Nova tentativa em ${LOGICA_AUTH_BACKOFF_MS[tentativa - 1]}ms.`,
        );
      }
    }

    this.logger.error(
      `Falha ao autenticar na Lógica após ${totalTentativas} tentativas baseOrigin=${baseOrigin ?? 'N/A'}: ${ultimoDetalhe}`,
    );
    throw new InternalServerErrorException(
      'Falha ao autenticar na API Lógica para renovação de token',
    );
  }

  /**
   * Uma tentativa de login no /autentica.
   *
   * @returns O token novo, ou null quando a Lógica recusou o login (resposta
   *          200 com erro=true/logado=false/token vazio — transitório).
   */
  private async executarAutenticacao(
    apiNumber: string,
  ): Promise<string | null> {
    const params = new URLSearchParams();
    params.append('usuario', apiNumber);
    params.append('senha', apiNumber);

    const response = await axios.post<LogicaAuthResponse>(
      this.buildUrl('/autentica'),
      params,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: LOGICA_REQUEST_TIMEOUT,
      },
    );

    const authData = response.data;
    const refreshedToken = authData?.token;

    if (
      !refreshedToken ||
      authData?.erro === true ||
      authData?.logado === false
    ) {
      return null;
    }

    return refreshedToken;
  }

  private buildUrl(path: string): string {
    const baseUrl = process.env.LOGICA_API_BASE_URL;

    if (!baseUrl) {
      throw new InternalServerErrorException(
        'LOGICA_API_BASE_URL não definida nas variáveis de ambiente',
      );
    }

    const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${normalized}/${path.replace(/^\//, '')}`;
  }
}

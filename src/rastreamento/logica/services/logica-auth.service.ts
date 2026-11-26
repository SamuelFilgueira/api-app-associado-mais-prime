import {
  buildLogicaUrl,
  LOGICA_REQUEST_TIMEOUT,
} from 'src/rastreamento/logica/constants/logica.constants';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import axios from 'axios';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { maskSecret } from 'src/shared/log.util';
import { erroInternoDeRastreamento } from 'src/rastreamento/helpers/erro-de-rastreamento';

const VENDOR = 'logica';

/**
 * Validade da sessão guardada no Redis. A Lógica não informa o prazo do
 * token; antes disso, uma resposta de "token inválido" já provoca a
 * renovação.
 */
const LOGICA_SESSAO_TTL_SEG = 12 * 60 * 60;

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
 *
 * A sessão fica no Redis (`VendorSessionStore`), e o login roda sob trava
 * entre processos: com mais de uma réplica, um processo autentica e os
 * outros reaproveitam o token — em vez de cada um fazer o próprio login e
 * derrubar a sessão dos demais.
 */
@Injectable()
export class LogicaAuthService {
  private readonly logger = new Logger(LogicaAuthService.name);

  /**
   * Token de sessão por base — cópia local do que está no Redis, para não ir
   * a ele a cada chamada. A fonte da verdade entre processos é o store.
   */
  private readonly tokenCache = new Map<string, string>();
  private readonly store: VendorSessionStore;

  constructor(
    // Opcional para os specs que instanciam o service com `new`: sem o store
    // do Nest, a sessão fica só na memória do processo.
    @Optional() store?: VendorSessionStore,
  ) {
    this.store = store ?? VendorSessionStore.emMemoria();
  }

  /**
   * Autenticações em voo por base (dedupe): chamadas paralelas que detectam
   * token inválido ao mesmo tempo compartilham UM único login em vez de
   * disparar logins simultâneos — que é justamente o que o throttle da
   * Lógica recusa.
   */
  private readonly authEmVoo = new Map<string, Promise<string>>();

  /**
   * Token para a PRIMEIRA tentativa de uma chamada: o cacheado (renovado por
   * qualquer fluxo ou por outro processo), senão o informado pelo chamador,
   * senão o LOGICA_TOKEN do env. Se a API recusar, o chamador deve pedir
   * renovarToken() informando o token recusado.
   */
  async obterTokenInicial(
    baseOrigin?: string,
    tokenFallback?: string,
  ): Promise<string> {
    const cacheKey = baseOrigin ?? 'default';
    let cacheado = this.tokenCache.get(cacheKey);
    if (!cacheado) {
      cacheado =
        (await this.store.ler(VENDOR, `token:${cacheKey}`)) ?? undefined;
      if (cacheado) this.tokenCache.set(cacheKey, cacheado);
    }
    const usedToken = cacheado ?? tokenFallback ?? process.env.LOGICA_TOKEN;

    if (!usedToken) {
      // O nome da variável fica só no log; o app recebe mensagem neutra.
      this.logger.error(
        'LOGICA_TOKEN não definido: token não fornecido nem presente em env',
      );
      throw erroInternoDeRastreamento('RASTREAMENTO_NAO_CONFIGURADO');
    }

    return usedToken;
  }

  /**
   * Autentica na Lógica com dedupe em voo por base: se já existe um login em
   * andamento para a mesma base, aguarda o resultado dele em vez de disparar
   * outro. O login em si tem retry com backoff (ver autenticarComRetry).
   *
   * `tokenRecusado` é o token que a API acabou de rejeitar. Com ele, se outro
   * processo já gravou um token diferente no Redis, esse é reaproveitado sem
   * novo login.
   */
  renovarToken(baseOrigin?: string, tokenRecusado?: string): Promise<string> {
    const cacheKey = baseOrigin ?? 'default';

    const emVoo = this.authEmVoo.get(cacheKey);
    if (emVoo) {
      return emVoo;
    }

    const promessa = this.store
      .comTrava(
        VENDOR,
        `login:${cacheKey}`,
        async () => {
          const guardado = await this.store.ler(VENDOR, `token:${cacheKey}`);
          if (guardado && tokenRecusado && guardado !== tokenRecusado) {
            return guardado;
          }
          const token = await this.autenticarComRetry(baseOrigin);
          await this.store.gravar(
            VENDOR,
            `token:${cacheKey}`,
            token,
            LOGICA_SESSAO_TTL_SEG,
          );
          return token;
        },
        // O login pode levar o backoff inteiro (2 + 4 + 6 s) mais os timeouts.
        { ttlMs: 90_000, esperaMs: 45_000 },
      )
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
      // O nome da variável fica só no log; o app recebe mensagem neutra.
      this.logger.error(
        'LOGICA_API_NUMBER não definido nas variáveis de ambiente',
      );
      throw erroInternoDeRastreamento('RASTREAMENTO_NAO_CONFIGURADO');
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
    return buildLogicaUrl(path);
  }
}

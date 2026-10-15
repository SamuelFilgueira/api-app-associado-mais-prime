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
 * Pausa mínima entre tentativas de login após uma falha que não seja o
 * bloqueio por extração (5xx, rede, credencial, restrição de horário).
 *
 * Sem ela, cada requisição que chega enquanto o login está falhando dispara
 * um novo `POST /usuario/autenticar`: com o app em uso, são dezenas de logins
 * por minuto contra um usuário que a Hinova já recusou.
 */
export const SGA_AUTH_COOLDOWN_FALHA_MS = 15_000;

/**
 * Tempo que um token de base bloqueado pela Hinova ("extração de dados") fica
 * fora da rotação antes de ser sondado de novo. O desbloqueio é automático
 * (~1h segundo a Hinova); sondar 1x por minuto por token basta para retomar
 * assim que liberar, sem insistir.
 */
export const SGA_TOKEN_BLOQUEIO_MS = 60_000;

export interface SgaRequestOptions {
  /**
   * Quando a Hinova responde o 403 de bloqueio, repetir a requisição com outro
   * token de base ainda livre (default `true`).
   *
   * Rotinas de varredura (paginação em massa) devem passar `false`: se a
   * varredura bloqueou o token em uso, continuar com os outros só os
   * queimaria também — e são eles que mantêm o app funcionando.
   */
  failoverTokenBase?: boolean;
  /**
   * Compartilhar com requisições idênticas em voo (mesma base, método, URL e
   * corpo): todas recebem a resposta de UMA única chamada à Hinova. Só para
   * leituras. A resposta é sempre viva — nada fica guardado depois que a
   * chamada termina.
   */
  compartilharEmVoo?: boolean;
}

/**
 * Falha de autenticação no SGA. `bloqueioTotal` indica que todos os tokens de
 * base configurados estão bloqueados pela Hinova.
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
 * Só esse caso tira o token da rotação; outros 403 seguem como antes.
 */
export function ehBloqueioPorExtracao(status: number, data: unknown): boolean {
  if (status !== 403 || data === null || data === undefined) return false;
  const texto = (typeof data === 'string' ? data : JSON.stringify(data))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return texto.includes('bloqueado') && texto.includes('extracao');
}

/** Sessão de um token de base: índice no env + `token_usuario` obtido com ele. */
export interface SessaoSga {
  indice: number;
  tokenUsuario: string;
}

/**
 * Autenticação na Hinova (SGA) com ROTAÇÃO dos tokens de base.
 *
 * A Hinova aplica a cota de "extração de dados" por token de base. Com um
 * único token ativo ("sticky"), todo o tráfego do app se concentrava nele até
 * cair, e o failover apenas transferia a mesma carga para o próximo, que caía
 * em seguida. Aqui cada token de base tem a própria sessão (`token_usuario`)
 * e as requisições alternam entre eles; um token bloqueado sai da rotação por
 * `SGA_TOKEN_BLOQUEIO_MS` e depois é sondado de novo. Com um único token
 * configurado o comportamento é o de sempre.
 */
@Injectable()
export class SgaAuthService {
  private readonly logger = new Logger(SgaAuthService.name);
  /** `token_usuario` por sessão (chave `base:indice`). */
  private readonly sessaoCache = new Map<string, string>();
  /** Logins em voo por sessão (dedupe). */
  private readonly authInFlight = new Map<string, Promise<string>>();
  /** Instante até o qual o token de base está fora da rotação (chave `base:indice`). */
  private readonly bloqueadoAte = new Map<string, number>();
  /** Último índice usado por base (rotação round-robin). */
  private readonly cursor = new Map<BaseOrigin, number>();
  /**
   * Pausa de login por base após falha que não seja bloqueio: até `ate`,
   * nenhuma sessão da base tenta `/usuario/autenticar`.
   */
  private readonly authCooldown = new Map<
    BaseOrigin,
    { ate: number; motivo: string }
  >();
  /** Requisições de leitura em voo, por base+método+URL+corpo. */
  private readonly requisicoesEmVoo = new Map<
    string,
    Promise<AxiosResponse<unknown>>
  >();

  constructor(private readonly tokenResolver: TokenResolverService) {}

  /**
   * `token_usuario` de uma sessão livre da base (compatibilidade). Prefira
   * `executeWithAuth`, que também trata bloqueio e 401.
   */
  async getUserToken(baseOrigin: BaseOrigin): Promise<string> {
    return (await this.obterSessao(baseOrigin)).tokenUsuario;
  }

  /** Invalida o `token_usuario` de todas as sessões da base. */
  invalidateUserToken(baseOrigin: BaseOrigin): void {
    for (const chave of [...this.sessaoCache.keys()]) {
      if (chave.startsWith(`${baseOrigin}:`)) this.sessaoCache.delete(chave);
    }
  }

  /** Estado dos tokens de base (para diagnóstico/log). */
  estadoTokensBase(baseOrigin: BaseOrigin): {
    total: number;
    ultimoUsado: number | null;
    bloqueados: number[];
  } {
    const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;
    const agora = Date.now();
    const bloqueados: number[] = [];
    for (let i = 0; i < total; i++) {
      if ((this.bloqueadoAte.get(this.chave(baseOrigin, i)) ?? 0) > agora) {
        bloqueados.push(i);
      }
    }
    return {
      total,
      ultimoUsado: this.cursor.get(baseOrigin) ?? null,
      bloqueados,
    };
  }

  async executeWithAuth<T>(
    baseOrigin: BaseOrigin,
    makeRequest: (tokenUsuario: string) => Promise<AxiosResponse<T>>,
    opcoes?: SgaRequestOptions,
  ): Promise<AxiosResponse<T>> {
    const sessao = await this.obterSessao(baseOrigin);
    let response = await makeRequest(sessao.tokenUsuario);

    if (ehBloqueioPorExtracao(response.status, response.data)) {
      this.marcarBloqueado(baseOrigin, sessao.indice);
      const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;

      // Failover desativado pelo chamador (varreduras): devolve o 403 e
      // preserva os demais tokens para o tráfego do app.
      if (opcoes?.failoverTokenBase === false || total === 1) {
        this.logger.warn(
          `${baseTag(baseOrigin)} token de base #${sessao.indice + 1}/${total} BLOQUEADO pela Hinova (extração de dados); fora da rotação por ${SGA_TOKEN_BLOQUEIO_MS / 1000}s. ${total > 1 ? 'Failover desativado para esta requisição.' : ''}`.trim(),
        );
        return response;
      }

      // Repete UMA vez com outro token livre. Seguro: a Hinova recusou a
      // requisição sem processá-la. Sem token livre, devolve o 403 como antes.
      const outra = await this.tentarObterSessao(baseOrigin);
      if (!outra) {
        this.logger.warn(
          `${baseTag(baseOrigin)} token de base #${sessao.indice + 1}/${total} BLOQUEADO pela Hinova (extração de dados) e nenhum outro token livre.`,
        );
        return response;
      }
      this.logger.warn(
        `${baseTag(baseOrigin)} token de base #${sessao.indice + 1}/${total} BLOQUEADO pela Hinova (extração de dados); fora da rotação por ${SGA_TOKEN_BLOQUEIO_MS / 1000}s. Repetindo com o token #${outra.indice + 1}.`,
      );
      return makeRequest(outra.tokenUsuario);
    }

    if (response.status !== 401) {
      return response;
    }

    this.logger.warn(
      `${baseTag(baseOrigin)} token_usuario da sessão #${sessao.indice + 1} inválido. Reautenticando automaticamente.`,
    );
    this.sessaoCache.delete(this.chave(baseOrigin, sessao.indice));
    const renovada = await this.autenticarSessao(baseOrigin, sessao.indice);
    response = await makeRequest(renovada);
    return response;
  }

  async executeRequestWithAuth<T>(
    baseOrigin: BaseOrigin,
    config: Omit<AxiosRequestConfig, 'headers'> & {
      headers?: Record<string, string>;
    } & SgaRequestOptions,
  ): Promise<AxiosResponse<T>> {
    const { failoverTokenBase, compartilharEmVoo, ...axiosConfig } = config;

    const executar = () =>
      this.executeWithAuth<T>(
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

    if (!compartilharEmVoo) {
      return executar();
    }

    const chave = `${baseOrigin}|${(axiosConfig.method ?? 'GET').toUpperCase()}|${axiosConfig.url}|${axiosConfig.data === undefined ? '' : JSON.stringify(axiosConfig.data)}`;
    const emVoo = this.requisicoesEmVoo.get(chave);
    if (emVoo) {
      return emVoo as Promise<AxiosResponse<T>>;
    }

    const promessa = executar().finally(() => {
      this.requisicoesEmVoo.delete(chave);
    });
    this.requisicoesEmVoo.set(chave, promessa);
    return promessa;
  }

  // ── Sessões e rotação ─────────────────────────────────────────────────────

  private chave(baseOrigin: BaseOrigin, indice: number): string {
    return `${baseOrigin}:${indice}`;
  }

  private estaBloqueado(baseOrigin: BaseOrigin, indice: number): boolean {
    return (
      (this.bloqueadoAte.get(this.chave(baseOrigin, indice)) ?? 0) > Date.now()
    );
  }

  private marcarBloqueado(baseOrigin: BaseOrigin, indice: number): void {
    this.bloqueadoAte.set(
      this.chave(baseOrigin, indice),
      Date.now() + SGA_TOKEN_BLOQUEIO_MS,
    );
    // A sessão desse token continua válida; só o token de base está bloqueado.
  }

  /**
   * Próximo índice livre na rotação (round-robin a partir do último usado).
   * `null` quando todos os tokens estão bloqueados.
   */
  private proximoIndiceLivre(baseOrigin: BaseOrigin): number | null {
    const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;
    const inicio = ((this.cursor.get(baseOrigin) ?? -1) + 1) % total;
    for (let i = 0; i < total; i++) {
      const indice = (inicio + i) % total;
      if (!this.estaBloqueado(baseOrigin, indice)) {
        this.cursor.set(baseOrigin, indice);
        return indice;
      }
    }
    return null;
  }

  /**
   * Sessão livre da base: escolhe o próximo token na rotação e garante o
   * `token_usuario` dele (cache ou login). Se o login desse token vier
   * bloqueado, tira-o da rotação e passa ao seguinte, até esgotar.
   * Lança `FalhaAutenticacaoSga` quando não há token livre ou o login falha.
   */
  private async obterSessao(baseOrigin: BaseOrigin): Promise<SessaoSga> {
    const sessao = await this.tentarObterSessao(baseOrigin);
    if (sessao) return sessao;

    const { total } = this.estadoTokensBase(baseOrigin);
    throw new FalhaAutenticacaoSga(
      `Falha ao autenticar no SGA para base ${baseOrigin}: todos os ${total} token(s) de base estão bloqueados pela Hinova; nova sondagem em até ${SGA_TOKEN_BLOQUEIO_MS / 1000}s`,
      true,
    );
  }

  /** Como `obterSessao`, mas devolve `null` quando todos os tokens estão bloqueados. */
  private async tentarObterSessao(
    baseOrigin: BaseOrigin,
  ): Promise<SessaoSga | null> {
    const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;

    for (let tentativa = 0; tentativa < total; tentativa++) {
      const indice = this.proximoIndiceLivre(baseOrigin);
      if (indice === null) return null;

      const cacheada = this.sessaoCache.get(this.chave(baseOrigin, indice));
      if (cacheada) return { indice, tokenUsuario: cacheada };

      try {
        const tokenUsuario = await this.autenticarSessao(baseOrigin, indice);
        return { indice, tokenUsuario };
      } catch (err: unknown) {
        // Bloqueio só desse token: já saiu da rotação; tenta o próximo.
        if (err instanceof FalhaAutenticacaoSga && err.bloqueioTotal) continue;
        throw err;
      }
    }
    return null;
  }

  /**
   * Login de UMA sessão (token de base `indice`), com dedupe em voo e pausa
   * da base após falha. Bloqueio por extração no login tira o token da
   * rotação e lança `FalhaAutenticacaoSga(bloqueioTotal=true)` para que o
   * chamador passe ao próximo.
   */
  private autenticarSessao(
    baseOrigin: BaseOrigin,
    indice: number,
  ): Promise<string> {
    const chave = this.chave(baseOrigin, indice);

    const inFlight = this.authInFlight.get(chave);
    if (inFlight) return inFlight;

    const cooldown = this.authCooldown.get(baseOrigin);
    if (cooldown && cooldown.ate > Date.now()) {
      const restanteSeg = Math.ceil((cooldown.ate - Date.now()) / 1000);
      return Promise.reject(
        new FalhaAutenticacaoSga(
          `Falha ao autenticar no SGA para base ${baseOrigin}: ${cooldown.motivo}; nova tentativa de login em ${restanteSeg}s`,
          false,
        ),
      );
    }

    const promessa = this.authenticate(baseOrigin, indice)
      .then((token) => {
        this.sessaoCache.set(chave, token);
        this.authCooldown.delete(baseOrigin);
        return token;
      })
      .catch((err: unknown) => {
        if (err instanceof FalhaAutenticacaoSga && err.bloqueioTotal) {
          this.marcarBloqueado(baseOrigin, indice);
        } else {
          this.registrarCooldown(baseOrigin);
        }
        throw err;
      })
      .finally(() => {
        this.authInFlight.delete(chave);
      });

    this.authInFlight.set(chave, promessa);
    return promessa;
  }

  /** Pausa de login da base após falha que não seja bloqueio por extração. */
  private registrarCooldown(baseOrigin: BaseOrigin): void {
    const motivo = 'último login no SGA falhou';
    this.authCooldown.set(baseOrigin, {
      ate: Date.now() + SGA_AUTH_COOLDOWN_FALHA_MS,
      motivo,
    });
    this.logger.warn(
      `${baseTag(baseOrigin)} login no SGA em pausa por ${SGA_AUTH_COOLDOWN_FALHA_MS / 1000}s (${motivo}). Requisições nesse intervalo falham sem chamar a Hinova.`,
    );
  }

  /** Uma chamada a `/usuario/autenticar` com o token de base `indice`. */
  private async authenticate(
    baseOrigin: BaseOrigin,
    indice: number,
  ): Promise<string> {
    const user = this.tokenResolver.resolveSgaUser(baseOrigin);
    const password = this.tokenResolver.resolveSgaPassword(baseOrigin);
    const tokensBase = this.tokenResolver.resolveSgaBaseTokens(baseOrigin);

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
      return response.data.token_usuario;
    }

    const bloqueado = ehBloqueioPorExtracao(response.status, response.data);
    if (bloqueado) {
      this.logger.warn(
        `${baseTag(baseOrigin)} token de base #${indice + 1}/${tokensBase.length} BLOQUEADO pela Hinova na autenticação (extração de dados); fora da rotação por ${SGA_TOKEN_BLOQUEIO_MS / 1000}s.`,
      );
    } else {
      this.logger.error(
        `${baseTag(baseOrigin)} falha na autenticação SGA (token de base #${indice + 1}/${tokensBase.length}): status=${response.status} body=${JSON.stringify(response.data)}`,
      );
    }
    throw new FalhaAutenticacaoSga(
      `Falha ao autenticar no SGA para base ${baseOrigin}`,
      bloqueado,
    );
  }
}

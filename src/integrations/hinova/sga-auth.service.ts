import {
  SGA_BASE_URL,
  SGA_SESSAO_TTL_SEG,
  SGA_TIMEOUT_LOGIN_MS,
  SGA_TIMEOUT_PADRAO_MS,
} from './hinova.constants';
import { Injectable, Logger, Optional } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  BaseOrigin,
  TokenResolverService,
} from 'src/shared/token-resolver.service';
import { baseTag } from 'src/shared/log.util';
import { hinovaOrcamentoPorMinuto } from 'src/config/integracoes.config';
import { Disjuntor } from 'src/integrations/core/disjuntor';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { medirVendor, metricas } from 'src/infra/observability/metricas';

const VENDOR = 'hinova';

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
  /**
   * `token_usuario` por sessão (chave `base:indice`) — cópia local da sessão
   * guardada no Redis (`VendorSessionStore`). O Redis é a fonte da verdade
   * entre os processos; esta cópia só evita uma ida ao Redis por requisição.
   */
  private readonly sessaoCache = new Map<string, string>();
  /** Logins em voo por sessão (dedupe dentro do processo). */
  private readonly authInFlight = new Map<string, Promise<string>>();
  /**
   * Instante até o qual o token de base está fora da rotação (chave
   * `base:indice`). Espelho local das marcas do Redis, sincronizado a cada
   * requisição para que um bloqueio visto por um processo valha para todos.
   */
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
  /** Chamadas por token de base no minuto corrente (orçamento). */
  private readonly usoPorMinuto = new Map<
    string,
    { minuto: number; total: number }
  >();
  private readonly disjuntor = new Disjuntor(VENDOR);
  private readonly store: VendorSessionStore;

  constructor(
    private readonly tokenResolver: TokenResolverService,
    // Opcional para os specs e scripts que instanciam o service com `new`:
    // sem o store do Nest, a sessão fica só na memória do processo.
    @Optional() store?: VendorSessionStore,
  ) {
    this.store = store ?? VendorSessionStore.emMemoria();
  }

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
      if (chave.startsWith(`${baseOrigin}:`)) {
        this.sessaoCache.delete(chave);
        void this.store.apagar(VENDOR, `usuario:${chave}`);
      }
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
    // Só invalida se a sessão guardada ainda é a que recebeu o 401. Um 401
    // tardio (de requisição feita com o token antigo) não pode apagar o token
    // que outra requisição — ou outro processo — acabou de obter: isso gerava
    // um login por 401 e, entre réplicas, uma derrubava a sessão da outra.
    const chave = this.chave(baseOrigin, sessao.indice);
    const recusado = sessao.tokenUsuario;
    if (this.sessaoCache.get(chave) === recusado) {
      this.sessaoCache.delete(chave);
    }
    await this.store.apagar(VENDOR, `usuario:${chave}`, recusado);

    const emCache =
      this.sessaoCache.get(chave) ??
      (await this.store.ler(VENDOR, `usuario:${chave}`));
    let renovada: string;
    if (emCache && emCache !== recusado) {
      this.sessaoCache.set(chave, emCache);
      renovada = emCache;
    } else {
      renovada = await this.autenticarSessao(baseOrigin, sessao.indice);
    }
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

    const operacao = operacaoDaUrl(axiosConfig.url);
    const executar = () =>
      this.executeWithAuth<T>(
        baseOrigin,
        (tokenUsuario) =>
          // O circuito só conta falha de transporte: timeout, rede e 5xx. O
          // 403 de bloqueio e os 4xx de negócio mostram a Hinova de pé.
          this.disjuntor.executar(
            baseOrigin,
            () =>
              medirVendor(
                { vendor: VENDOR, base: baseOrigin, operacao },
                () =>
                  axios.request<T>({
                    ...axiosConfig,
                    timeout: axiosConfig.timeout ?? SGA_TIMEOUT_PADRAO_MS,
                    headers: {
                      ...(axiosConfig.headers ?? {}),
                      Authorization: `Bearer ${tokenUsuario}`,
                    },
                    validateStatus: axiosConfig.validateStatus ?? (() => true),
                  }),
                classificarErroDeRede,
              ),
            (resposta) => resposta.status >= 500,
          ),
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
    const ate = Date.now() + SGA_TOKEN_BLOQUEIO_MS;
    this.bloqueadoAte.set(this.chave(baseOrigin, indice), ate);
    metricas.hinovaTokenBloqueado.inc({ base: baseOrigin });
    // Avisa os outros processos: sem isto cada réplica sondaria o token
    // bloqueado por conta própria, multiplicando as chamadas recusadas.
    void this.store.gravar(
      VENDOR,
      `bloqueio:${this.chave(baseOrigin, indice)}`,
      String(ate),
      Math.ceil(SGA_TOKEN_BLOQUEIO_MS / 1000),
    );
    // A sessão desse token continua válida; só o token de base está bloqueado.
  }

  /**
   * Traz para a memória as marcas de bloqueio e a pausa de login que outros
   * processos gravaram. Uma ida ao Redis (`MGET`) por requisição.
   */
  private async sincronizarEstado(baseOrigin: BaseOrigin): Promise<void> {
    const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;
    const chaves = [
      `cooldown:${baseOrigin}`,
      ...Array.from(
        { length: total },
        (_, i) => `bloqueio:${this.chave(baseOrigin, i)}`,
      ),
    ];
    const [cooldown, ...bloqueios] = await this.store.lerVarios(VENDOR, chaves);
    const agora = Date.now();

    bloqueios.forEach((valor, indice) => {
      const ate = Number(valor);
      const chave = this.chave(baseOrigin, indice);
      if (ate > agora && ate > (this.bloqueadoAte.get(chave) ?? 0)) {
        this.bloqueadoAte.set(chave, ate);
      }
    });

    if (cooldown) {
      const separador = cooldown.indexOf('|');
      const ate = Number(cooldown.slice(0, separador));
      const atual = this.authCooldown.get(baseOrigin);
      if (ate > agora && ate > (atual?.ate ?? 0)) {
        this.authCooldown.set(baseOrigin, {
          ate,
          motivo: cooldown.slice(separador + 1),
        });
      }
    }
  }

  /**
   * Conta a chamada no orçamento do token de base e diz se ele ainda tem
   * folga neste minuto. Com `HINOVA_ORCAMENTO_POR_MINUTO` em 0, só conta.
   */
  private dentroDoOrcamento(baseOrigin: BaseOrigin, indice: number): boolean {
    const limite = hinovaOrcamentoPorMinuto();
    if (limite === 0) return true;

    const minuto = Math.floor(Date.now() / 60_000);
    const chave = this.chave(baseOrigin, indice);
    const uso = this.usoPorMinuto.get(chave);
    if (!uso || uso.minuto !== minuto) {
      this.usoPorMinuto.set(chave, { minuto, total: 1 });
      return true;
    }
    uso.total += 1;
    return uso.total <= limite;
  }

  /**
   * Próximo índice livre na rotação (round-robin a partir do último usado).
   * `null` quando todos os tokens estão bloqueados.
   */
  private proximoIndiceLivre(baseOrigin: BaseOrigin): number | null {
    const total = this.tokenResolver.resolveSgaBaseTokens(baseOrigin).length;
    const inicio = ((this.cursor.get(baseOrigin) ?? -1) + 1) % total;
    let livreForaDoOrcamento: number | null = null;

    for (let i = 0; i < total; i++) {
      const indice = (inicio + i) % total;
      if (this.estaBloqueado(baseOrigin, indice)) continue;
      if (this.dentroDoOrcamento(baseOrigin, indice)) {
        this.cursor.set(baseOrigin, indice);
        return indice;
      }
      livreForaDoOrcamento ??= indice;
    }

    // Todos os tokens livres estouraram o orçamento do minuto: segue com o
    // primeiro deles. O orçamento distribui a carga; recusar a requisição do
    // associado seria pior do que o risco que ele tenta evitar.
    if (livreForaDoOrcamento !== null) {
      this.cursor.set(baseOrigin, livreForaDoOrcamento);
    }
    return livreForaDoOrcamento;
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
    await this.sincronizarEstado(baseOrigin);

    for (let tentativa = 0; tentativa < total; tentativa++) {
      const indice = this.proximoIndiceLivre(baseOrigin);
      if (indice === null) return null;

      const chave = this.chave(baseOrigin, indice);
      const cacheada =
        this.sessaoCache.get(chave) ??
        (await this.store.ler(VENDOR, `usuario:${chave}`));
      if (cacheada) {
        this.sessaoCache.set(chave, cacheada);
        return { indice, tokenUsuario: cacheada };
      }

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

    // Trava entre processos: um autentica, os outros esperam e reaproveitam
    // a sessão gravada — em vez de cada réplica fazer o próprio login.
    const promessa = this.store
      .comTrava(
        VENDOR,
        `login:${chave}`,
        async () => {
          const jaGravada = await this.store.ler(VENDOR, `usuario:${chave}`);
          if (jaGravada) return jaGravada;

          const token = await this.authenticate(baseOrigin, indice);
          await this.store.gravar(
            VENDOR,
            `usuario:${chave}`,
            token,
            SGA_SESSAO_TTL_SEG,
          );
          return token;
        },
        { ttlMs: SGA_TIMEOUT_LOGIN_MS + 5_000, esperaMs: SGA_TIMEOUT_LOGIN_MS },
      )
      .then((token) => {
        this.sessaoCache.set(chave, token);
        this.authCooldown.delete(baseOrigin);
        return token;
      })
      .catch((err: unknown) => {
        if (err instanceof FalhaAutenticacaoSga && err.bloqueioTotal) {
          this.marcarBloqueado(baseOrigin, indice);
        } else {
          metricas.sgaAuthFalhas.inc({ base: baseOrigin });
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
    const ate = Date.now() + SGA_AUTH_COOLDOWN_FALHA_MS;
    this.authCooldown.set(baseOrigin, { ate, motivo });
    void this.store.gravar(
      VENDOR,
      `cooldown:${baseOrigin}`,
      `${ate}|${motivo}`,
      Math.ceil(SGA_AUTH_COOLDOWN_FALHA_MS / 1000),
    );
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
        timeout: SGA_TIMEOUT_LOGIN_MS,
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

/**
 * Rótulo de métrica para a chamada: o caminho do SGA com os valores trocados
 * por `:id` (`/associado/buscar/:id`). Nunca a URL crua — ela carrega CPF e
 * código de veículo.
 */
export function operacaoDaUrl(url: string | undefined): string {
  if (!url) return 'desconhecida';
  const caminho = url
    .replace(SGA_BASE_URL, '')
    .replace(/^https?:\/\/[^/]+/, '')
    .split('?')[0];
  return (
    caminho
      .split('/')
      .map((parte) => (/\d/.test(parte) ? ':id' : parte))
      .join('/')
      .slice(0, 80) || '/'
  );
}

function classificarErroDeRede(erro: unknown): 'erro' | 'timeout' {
  const codigo = (erro as { code?: unknown } | null)?.code;
  return codigo === 'ECONNABORTED' || codigo === 'ETIMEDOUT'
    ? 'timeout'
    : 'erro';
}

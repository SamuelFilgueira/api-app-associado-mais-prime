import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import axios from 'axios';
import { papelAtivo } from 'src/config/app.config';
import { BaseOrigin, TENANT, isTenantBase } from 'src/config/tenant.config';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { m7ApiBaseUrl } from 'src/rastreamento/m7/constants/m7.constants';
import { baseTag, maskSecret } from 'src/shared/log.util';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

const VENDOR = 'm7';

/** Timeout do login na M7 (ms). */
const M7_LOGIN_TIMEOUT_MS = 15_000;

/** De quanto em quanto tempo cada processo confere a idade da sessão. */
export const M7_RENOVACAO_PERIODICA_MS = 30 * 60 * 1000;

/**
 * Validade da sessão no Redis quando a M7 não informa um prazo utilizável.
 * Um prazo maior que o real não quebra nada: a M7 responde 401 e a chamada
 * renova o token.
 */
const M7_SESSAO_TTL_PADRAO_SEG = 60 * 60;
const M7_SESSAO_TTL_MAXIMO_SEG = 24 * 60 * 60;

/**
 * Pausa entre tentativas de login depois de uma falha. Sem ela, com a M7
 * recusando o login, cada consulta de posição (o app consulta a cada 5 s)
 * dispararia um login novo.
 */
export const M7_PAUSA_APOS_FALHA_MS = 15_000;

/** Sessão da M7 de uma base, como fica guardada no `VendorSessionStore`. */
export interface SessaoM7 {
  token: string;
  /** `expires_in` devolvido pelo login, como veio. */
  expiresIn: unknown;
  /** Quando o login foi feito (ms). */
  obtidoEm: number;
}

interface M7LoginResponse {
  sucesso?: boolean;
  token?: string;
  expires_in?: unknown;
}

function ttlDaSessaoSeg(expiresIn: unknown): number {
  const segundos =
    typeof expiresIn === 'number'
      ? expiresIn
      : typeof expiresIn === 'string' && /^\d+$/.test(expiresIn.trim())
        ? Number(expiresIn)
        : Number.NaN;
  if (!Number.isFinite(segundos) || segundos <= 120) {
    return M7_SESSAO_TTL_PADRAO_SEG;
  }
  return Math.min(Math.trunc(segundos) - 60, M7_SESSAO_TTL_MAXIMO_SEG);
}

/**
 * Sessão ÚNICA da M7 por base, para toda a aplicação (mesmo papel do
 * `LogicaAuthService` e do `SgaAuthService`).
 *
 * Antes o token ficava num objeto em memória de cada processo: com mais de
 * uma réplica, cada uma fazia o próprio login no boot e a cada 30 minutos.
 * Agora a sessão fica no Redis (`VendorSessionStore`) e o login roda sob
 * trava entre processos — um processo autentica, os outros reaproveitam.
 *
 * - No boot, só faz login se NÃO houver sessão guardada.
 * - A renovação periódica só faz login se a sessão guardada estiver velha
 *   (outro processo pode ter renovado nesse meio-tempo).
 * - Token recusado pela M7 (401): se o guardado já é outro, ele é adotado.
 */
@Injectable()
export class M7AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M7AuthService.name);

  /** Cópia local da sessão guardada: evita uma ida ao Redis por chamada. */
  private readonly sessaoLocal = new Map<BaseOrigin, SessaoM7>();
  /** Autenticações em voo por base (dedupe dentro do processo). */
  private readonly emVoo = new Map<BaseOrigin, Promise<SessaoM7>>();
  /** Última falha de login por base: até `ate`, não tenta de novo. */
  private readonly pausaDeLogin = new Map<
    BaseOrigin,
    { ate: number; erro: Error }
  >();
  private readonly store: VendorSessionStore;
  private readonly credenciais: TenantCredentialsRegistry;
  private temporizador?: NodeJS.Timeout;

  constructor(
    // Opcionais para os specs que instanciam o service com `new`: sem o
    // store do Nest, a sessão fica só na memória do processo.
    @Optional() credenciais?: TenantCredentialsRegistry,
    @Optional() store?: VendorSessionStore,
  ) {
    this.credenciais = credenciais ?? new TenantCredentialsRegistry();
    this.store = store ?? VendorSessionStore.emMemoria();
  }

  async onModuleInit(): Promise<void> {
    // Só a API fala com a M7 a cada requisição; nos outros papéis a sessão é
    // obtida sob demanda, se algum dia for preciso.
    if (!papelAtivo('api')) return;

    const bases = TENANT.baseNames.filter((base) => this.estaConfigurada(base));
    const resultados = await Promise.allSettled(
      bases.map((base) => this.obterToken(base)),
    );
    resultados.forEach((resultado, indice) => {
      if (resultado.status === 'rejected') {
        this.logger.warn(
          `${baseTag(bases[indice])} sessão da M7 não obtida no boot; a primeira chamada tenta de novo.`,
        );
      }
    });

    this.temporizador = setInterval(() => {
      for (const base of bases) {
        this.renovarSeAntiga(base).catch((erro: unknown) => {
          // A falha já foi registrada no login; a próxima chamada à M7 que
          // receber 401 renova por conta própria.
          this.logger.warn(
            `${baseTag(base)} renovação periódica da sessão da M7 falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
          );
        });
      }
    }, M7_RENOVACAO_PERIODICA_MS);
    this.temporizador.unref();
  }

  onModuleDestroy(): void {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  /** A base tem as credenciais da M7? Nunca lança nem registra erro. */
  estaConfigurada(base: BaseOrigin): boolean {
    if (!isTenantBase(base)) return false;
    return !this.credenciais.integracoesIncompletas(base).m7;
  }

  /**
   * Token para a próxima chamada: a cópia local, senão a sessão guardada por
   * qualquer processo, senão um login novo (sob trava).
   */
  async obterToken(baseOrigin: BaseOrigin): Promise<string> {
    const base = exigirBase(baseOrigin, 'sessão da M7');
    const local = this.sessaoLocal.get(base);
    if (local) return local.token;

    const sessao = await this.autenticar(base, () => true);
    return sessao.token;
  }

  /**
   * Renova a sessão da base.
   *
   * Sem `tokenRecusado` o login é forçado (rota operacional). Com ele — o
   * token que a M7 acabou de recusar —, se outro processo já guardou um token
   * diferente, esse é adotado sem novo login.
   */
  renovar(baseOrigin: BaseOrigin, tokenRecusado?: string): Promise<SessaoM7> {
    const base = exigirBase(baseOrigin, 'renovação do token M7');
    // Renovação pedida pelo operador ignora a pausa de login.
    if (tokenRecusado === undefined) this.pausaDeLogin.delete(base);
    return this.autenticar(
      base,
      (guardada) =>
        tokenRecusado !== undefined && guardada.token !== tokenRecusado,
    );
  }

  /** Renovação periódica: só faz login se a sessão guardada já estiver velha. */
  renovarSeAntiga(baseOrigin: BaseOrigin): Promise<SessaoM7> {
    const base = exigirBase(baseOrigin, 'renovação periódica do token M7');
    const idadeMaxima = M7_RENOVACAO_PERIODICA_MS - 60_000;
    return this.autenticar(
      base,
      (guardada) => Date.now() - guardada.obtidoEm < idadeMaxima,
    );
  }

  /**
   * Um login por vez por base, no processo (dedupe em voo) e entre processos
   * (trava no Redis). Dentro da trava a sessão guardada é relida: se ela
   * serve (`aceitar`), é adotada e nenhum login acontece.
   *
   * Depois de um login que falhou, novas tentativas esperam
   * `M7_PAUSA_APOS_FALHA_MS` — a adoção de uma sessão guardada continua
   * valendo durante a pausa.
   */
  private autenticar(
    base: BaseOrigin,
    aceitar: (guardada: SessaoM7) => boolean,
  ): Promise<SessaoM7> {
    const emVoo = this.emVoo.get(base);
    if (emVoo) return emVoo;

    const promessa = this.store
      .comTrava(
        VENDOR,
        `login:${base}`,
        async () => {
          const guardada = await this.lerGuardada(base);
          if (guardada && aceitar(guardada)) return guardada;

          const pausa = this.pausaDeLogin.get(base);
          if (pausa && pausa.ate > Date.now()) throw pausa.erro;

          const nova = await this.loginComPausa(base);
          await this.store.gravar(
            VENDOR,
            `token:${base}`,
            JSON.stringify(nova),
            ttlDaSessaoSeg(nova.expiresIn),
          );
          return nova;
        },
        {
          ttlMs: M7_LOGIN_TIMEOUT_MS + 5_000,
          esperaMs: M7_LOGIN_TIMEOUT_MS,
        },
      )
      .then((sessao) => {
        this.sessaoLocal.set(base, sessao);
        return sessao;
      })
      .finally(() => {
        this.emVoo.delete(base);
      });

    this.emVoo.set(base, promessa);
    return promessa;
  }

  /** Login que, ao falhar, abre a pausa da base; ao dar certo, a fecha. */
  private async loginComPausa(base: BaseOrigin): Promise<SessaoM7> {
    try {
      const sessao = await this.login(base);
      this.pausaDeLogin.delete(base);
      return sessao;
    } catch (erro) {
      this.pausaDeLogin.set(base, {
        ate: Date.now() + M7_PAUSA_APOS_FALHA_MS,
        erro: erro instanceof Error ? erro : new Error(String(erro)),
      });
      throw erro;
    }
  }

  private async lerGuardada(base: BaseOrigin): Promise<SessaoM7 | null> {
    const bruto = await this.store.ler(VENDOR, `token:${base}`);
    if (!bruto) return null;
    try {
      const sessao = JSON.parse(bruto) as Partial<SessaoM7>;
      return typeof sessao?.token === 'string' && sessao.token
        ? {
            token: sessao.token,
            expiresIn: sessao.expiresIn ?? null,
            obtidoEm: Number(sessao.obtidoEm) || 0,
          }
        : null;
    } catch {
      // Valor ilegível no Redis vale como "sem sessão": o login regrava.
      return null;
    }
  }

  /** Login na M7 com a credencial da PRÓPRIA base. */
  private async login(base: BaseOrigin): Promise<SessaoM7> {
    const { token: apiM7Token, codigo } = this.credenciais.m7(base);

    let resposta: M7LoginResponse | undefined;
    try {
      const response = await axios.post<M7LoginResponse>(
        `${m7ApiBaseUrl()}login`,
        { codigo, api_m7_token: apiM7Token },
        { timeout: M7_LOGIN_TIMEOUT_MS },
      );
      resposta = response.data;
    } catch (error) {
      this.logger.error(
        `[${base}] Erro ao renovar token: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
      );
      throw new InternalServerErrorException('Erro ao renovar token');
    }

    if (!resposta?.sucesso || !resposta.token) {
      this.logger.error(`[${base}] Falha ao renovar token - sucesso=false`);
      throw new InternalServerErrorException('Falha ao renovar token');
    }

    this.logger.log(
      `${baseTag(base)} sessão da M7 renovada (token=${maskSecret(resposta.token)})`,
    );
    return {
      token: resposta.token,
      expiresIn: resposta.expires_in ?? null,
      obtidoEm: Date.now(),
    };
  }
}

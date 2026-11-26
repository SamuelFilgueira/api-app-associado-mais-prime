import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';

/** Apaga a chave só se ela ainda guarda o valor informado. */
const SCRIPT_APAGAR_SE_IGUAL = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface ValorLocal {
  valor: string;
  expiraEm: number;
}

export interface OpcoesDeTrava {
  /** Quanto a trava dura se o dono morrer sem soltar. */
  ttlMs?: number;
  /** Quanto esperar por quem está com a trava antes de desistir. */
  esperaMs?: number;
}

/**
 * Estado de sessão de vendor compartilhado entre os processos (Redis):
 * token de usuário do SGA, token da M7, JWT da Softruck, token da Lógica,
 * marcas de bloqueio e de pausa de login.
 *
 * Antes cada processo guardava isso num `Map`. Com mais de uma réplica, cada
 * uma fazia o próprio login — e, nos vendors em que um login novo derruba a
 * sessão anterior, uma réplica invalidava a outra a cada requisição.
 *
 * Chaves: `sessao:{vendor}:{chave}` (a chave começa pela base).
 *
 * Com o Redis fora, o store cai para a memória do processo: o comportamento
 * volta a ser o de antes (uma sessão por processo), sem derrubar a API.
 */
@Injectable()
export class VendorSessionStore {
  private readonly logger = new Logger(VendorSessionStore.name);
  private readonly local = new Map<string, ValorLocal>();
  private ultimoAviso = 0;

  constructor(@Inject(REDIS_CLIENTE) private readonly redis: Redis | null) {}

  /**
   * Store sem Redis, só com a memória do processo. Para testes de unidade e
   * para quem instancia um client fora do Nest.
   */
  static emMemoria(): VendorSessionStore {
    return new VendorSessionStore(null);
  }

  async ler(vendor: string, chave: string): Promise<string | null> {
    const k = this.chave(vendor, chave);
    if (!this.redis) return this.lerLocal(k);
    try {
      return await this.redis.get(k);
    } catch (erro) {
      this.avisar(erro);
      return this.lerLocal(k);
    }
  }

  async gravar(
    vendor: string,
    chave: string,
    valor: string,
    ttlSeg: number,
  ): Promise<void> {
    const k = this.chave(vendor, chave);
    // A cópia local cobre a queda do Redis logo depois do login.
    this.local.set(k, { valor, expiraEm: Date.now() + ttlSeg * 1000 });
    if (!this.redis) return;
    try {
      await this.redis.set(k, valor, 'EX', Math.max(1, Math.trunc(ttlSeg)));
    } catch (erro) {
      this.avisar(erro);
    }
  }

  /**
   * Apaga a sessão. Com `seValorFor`, só apaga se a chave ainda guarda esse
   * valor: um 401 tardio, de requisição feita com o token antigo, não derruba
   * o token que outro processo acabou de obter.
   */
  async apagar(
    vendor: string,
    chave: string,
    seValorFor?: string,
  ): Promise<void> {
    const k = this.chave(vendor, chave);
    const local = this.local.get(k);
    if (seValorFor === undefined || local?.valor === seValorFor) {
      this.local.delete(k);
    }
    if (!this.redis) return;
    try {
      if (seValorFor === undefined) await this.redis.del(k);
      else await this.redis.eval(SCRIPT_APAGAR_SE_IGUAL, 1, k, seValorFor);
    } catch (erro) {
      this.avisar(erro);
    }
  }

  /** Várias chaves numa ida só (`MGET`), na ordem pedida. */
  async lerVarios(
    vendor: string,
    chaves: string[],
  ): Promise<Array<string | null>> {
    if (chaves.length === 0) return [];
    const ks = chaves.map((c) => this.chave(vendor, c));
    if (!this.redis) return ks.map((k) => this.lerLocal(k));
    try {
      return await this.redis.mget(...ks);
    } catch (erro) {
      this.avisar(erro);
      return ks.map((k) => this.lerLocal(k));
    }
  }

  /**
   * Executa `fn` com exclusão mútua entre processos (`SET NX PX`). Usada no
   * login: um processo autentica, os outros esperam e leem a sessão pronta.
   *
   * Se a trava não for obtida dentro de `esperaMs`, `fn` roda mesmo assim —
   * dois logins são piores que um, mas melhores que nenhum.
   */
  async comTrava<T>(
    vendor: string,
    chave: string,
    fn: () => Promise<T>,
    opcoes: OpcoesDeTrava = {},
  ): Promise<T> {
    const ttlMs = opcoes.ttlMs ?? 30_000;
    const esperaMs = opcoes.esperaMs ?? 20_000;
    const k = `${this.chave(vendor, chave)}:trava`;
    const dono = randomUUID();
    const prazo = Date.now() + esperaMs;
    let obtida = false;
    const redis = this.redis;

    if (redis) {
      try {
        for (;;) {
          obtida = (await redis.set(k, dono, 'PX', ttlMs, 'NX')) === 'OK';
          if (obtida || Date.now() >= prazo) break;
          await new Promise((resolver) => setTimeout(resolver, 150));
        }
      } catch (erro) {
        // Sem Redis não há trava entre processos; segue só com a deste processo.
        this.avisar(erro);
      }
    }

    try {
      return await fn();
    } finally {
      if (obtida && redis) {
        try {
          await redis.eval(SCRIPT_APAGAR_SE_IGUAL, 1, k, dono);
        } catch {
          // A expiração solta a trava.
        }
      }
    }
  }

  private chave(vendor: string, chave: string): string {
    return `sessao:${vendor}:${chave}`;
  }

  private lerLocal(k: string): string | null {
    const local = this.local.get(k);
    if (!local) return null;
    if (local.expiraEm <= Date.now()) {
      this.local.delete(k);
      return null;
    }
    return local.valor;
  }

  private avisar(erro: unknown): void {
    const agora = Date.now();
    if (agora - this.ultimoAviso < 60_000) return;
    this.ultimoAviso = agora;
    this.logger.warn(
      `Sessões de vendor sem Redis (${erro instanceof Error ? erro.message : String(erro)}); usando a memória deste processo.`,
    );
  }
}

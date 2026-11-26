import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';

/**
 * Janela fixa atômica. `INCR` e `PEXPIRE` rodam no mesmo script: se o
 * processo cair entre os dois, a chave não fica sem expiração (o defeito dos
 * limitadores antigos, que deixava o cliente em 429 para sempre). O ramo do
 * `PTTL < 0` conserta chaves órfãs criadas antes desta versão.
 *
 * `ARGV[2] = 0` só consulta, sem contar — usado pelas políticas que contam
 * apenas falhas.
 */
const SCRIPT_JANELA = `
local atual
if tonumber(ARGV[2]) == 1 then
  atual = redis.call('INCR', KEYS[1])
else
  atual = tonumber(redis.call('GET', KEYS[1]) or '0')
end
local ttl = redis.call('PTTL', KEYS[1])
if atual > 0 and ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {atual, ttl}
`;

export interface ResultadoDoLimite {
  /** Contagem na janela, já com esta requisição se `contar` for true. */
  total: number;
  /** Quanto falta para a janela zerar. */
  restanteMs: number;
}

/**
 * Contador de janela fixa compartilhado entre as réplicas (Redis), com um
 * substituto em memória para quando o Redis está fora.
 */
@Injectable()
export class LimitadorService {
  private readonly logger = new Logger(LimitadorService.name);
  private readonly local = new Map<
    string,
    { total: number; expiraEm: number }
  >();
  private ultimoAvisoRedis = 0;

  constructor(@Inject(REDIS_CLIENTE) private readonly redis: Redis) {}

  /**
   * Conta (ou só consulta) uma chave numa janela de `janelaSeg` segundos.
   *
   * @throws quando o Redis está indisponível — o chamador decide a política
   *         (liberar, ou cair em `consumirLocal`).
   */
  async consumir(
    chave: string,
    janelaSeg: number,
    contar = true,
  ): Promise<ResultadoDoLimite> {
    const [total, ttl] = (await this.redis.eval(
      SCRIPT_JANELA,
      1,
      chave,
      String(janelaSeg * 1000),
      contar ? '1' : '0',
    )) as [number, number];

    return { total: Number(total), restanteMs: Math.max(0, Number(ttl)) };
  }

  /**
   * Mesma contagem, na memória deste processo. Vale só para esta réplica,
   * mas mantém o freio de força bruta enquanto o Redis está fora — em vez de
   * escolher entre liberar tudo e recusar todo mundo.
   */
  consumirLocal(
    chave: string,
    janelaSeg: number,
    contar = true,
  ): ResultadoDoLimite {
    const agora = Date.now();
    let registro = this.local.get(chave);
    if (!registro || registro.expiraEm <= agora) {
      registro = { total: 0, expiraEm: agora + janelaSeg * 1000 };
      if (contar) this.local.set(chave, registro);
    }
    if (contar) registro.total += 1;

    if (this.local.size > 50_000) this.limparLocal(agora);
    return { total: registro.total, restanteMs: registro.expiraEm - agora };
  }

  /**
   * Ocupa uma vaga de execução simultânea e devolve quantas estão em uso.
   * A expiração devolve a vaga sozinha se o processo morrer no meio.
   */
  async ocuparVaga(chave: string, ttlSeg: number): Promise<number> {
    const resultado = await this.redis
      .multi()
      .incr(chave)
      .expire(chave, ttlSeg)
      .exec();
    const [erro, total] = resultado?.[0] ?? [null, 0];
    if (erro) throw erro;
    return Number(total);
  }

  async liberarVaga(chave: string): Promise<void> {
    try {
      const restante = await this.redis.decr(chave);
      if (restante <= 0) await this.redis.del(chave);
    } catch {
      // A expiração da chave devolve a vaga.
    }
  }

  /** Loga a queda do Redis no máximo uma vez por minuto. */
  avisarRedisFora(erro: unknown): void {
    const agora = Date.now();
    if (agora - this.ultimoAvisoRedis < 60_000) return;
    this.ultimoAvisoRedis = agora;
    this.logger.warn(
      `Limitador sem Redis (${erro instanceof Error ? erro.message : String(erro)}); usando a política de contingência de cada rota.`,
    );
  }

  private limparLocal(agora: number): void {
    for (const [chave, registro] of this.local) {
      if (registro.expiraEm <= agora) this.local.delete(chave);
    }
  }
}

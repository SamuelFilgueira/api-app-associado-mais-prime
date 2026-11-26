import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';
import { InfraError } from 'src/shared/erros/erros';

const SCRIPT_SOLTAR = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const SCRIPT_RENOVAR = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export type ResultadoDaTrava<T> =
  | { executou: true; valor: T }
  | { executou: false };

/**
 * Trava distribuída para rotinas que só podem rodar UMA vez por vez no
 * deploy inteiro: régua diária de boletos, disparo de marketing, varreduras.
 *
 * `tentar` não espera: se outro processo está com a trava, devolve
 * `{ executou: false }` e o chamador decide (pular a rodada, responder 409).
 * A trava expira sozinha se o dono morrer, e é renovada enquanto a rotina
 * roda — então o TTL pode ser curto sem cortar uma execução longa.
 *
 * Sem Redis a rotina NÃO roda (lança `InfraError`): rodar sem exclusão é
 * exatamente o que a trava existe para impedir.
 */
@Injectable()
export class TravaService {
  private readonly logger = new Logger(TravaService.name);

  constructor(@Inject(REDIS_CLIENTE) private readonly redis: Redis) {}

  async tentar<T>(
    chave: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<ResultadoDaTrava<T>> {
    const k = `trava:${chave}`;
    const dono = randomUUID();

    let obtida: boolean;
    try {
      obtida = (await this.redis.set(k, dono, 'PX', ttlMs, 'NX')) === 'OK';
    } catch (erro) {
      throw new InfraError('redis', undefined, erro);
    }
    if (!obtida) return { executou: false };

    // Renova a um terço do TTL enquanto a rotina estiver rodando.
    const renovacao = setInterval(
      () => {
        this.redis
          .eval(SCRIPT_RENOVAR, 1, k, dono, String(ttlMs))
          .catch((erro: Error) =>
            this.logger.warn(`Renovação da trava ${chave}: ${erro.message}`),
          );
      },
      Math.max(1_000, Math.floor(ttlMs / 3)),
    );
    renovacao.unref();

    try {
      return { executou: true, valor: await fn() };
    } finally {
      clearInterval(renovacao);
      try {
        await this.redis.eval(SCRIPT_SOLTAR, 1, k, dono);
      } catch {
        // A expiração solta a trava.
      }
    }
  }
}

import Redis from 'ioredis';

/**
 * Ambiente dos testes de integração: Redis e MariaDB REAIS, descartáveis.
 *
 * Não vale simular os dois: mock de ioredis não executa os scripts Lua, e
 * fake de transação não reproduz isolamento, trava nem violação de unique.
 *
 * Variáveis (o CI sobe os serviços como containers; localmente, ver
 * `docs/TESTES.md`):
 *  - `TEST_REDIS_URL`    ex.: redis://127.0.0.1:6390/0
 *  - `TEST_DATABASE_URL` ex.: mysql://root:senha@127.0.0.1:3317/beneficios_teste
 *
 * Sem a variável, a suíte correspondente é pulada (não falha): rodar
 * `npm test` numa máquina sem os serviços continua funcionando.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** `describe` que só roda com o Redis de teste configurado. */
export const describeComRedis = TEST_REDIS_URL ? describe : describe.skip;
/** `describe` que só roda com o banco de teste configurado. */
export const describeComBanco = TEST_DATABASE_URL ? describe : describe.skip;

/** Opções de conexão do Redis de teste, no formato do ioredis/BullMQ. */
export function opcoesDoRedisDeTeste(): {
  host: string;
  port: number;
  db: number;
  password?: string;
} {
  const url = new URL(TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/0');
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    db: Number(url.pathname.replace('/', '')) || 0,
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

/** Cliente novo no Redis de teste; quem cria fecha (`quit`). */
export function redisDeTeste(): Redis {
  return new Redis({
    ...opcoesDoRedisDeTeste(),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
  });
}

/** Apaga as chaves com o prefixo informado (nunca `FLUSHDB`). */
export async function limparChaves(
  redis: Redis,
  prefixo: string,
): Promise<void> {
  const chaves = await redis.keys(`${prefixo}*`);
  if (chaves.length > 0) await redis.del(...chaves);
}

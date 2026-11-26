/**
 * Fonte única da conexão com o Redis (BullMQ, cache, rate limit e sessões de
 * vendor). Antes cada provider lia `REDIS_HOST`/`REDIS_PORT` por conta própria
 * e nenhum sabia enviar senha.
 *
 * Envs:
 *  - REDIS_HOST (padrão: localhost) — no Docker, o nome do serviço (`redis`)
 *  - REDIS_PORT (padrão: 6379)
 *  - REDIS_PASSWORD (opcional) — obrigatória em produção: o Redis guarda as
 *    filas e as sessões de vendor e não deve aceitar conexão anônima
 *  - REDIS_USERNAME (opcional, ACL do Redis 6+)
 *  - REDIS_DB (opcional, padrão 0)
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
}

export function redisConnectionOptions(
  env: NodeJS.ProcessEnv = process.env,
): RedisConnectionOptions {
  const opcoes: RedisConnectionOptions = {
    host: env.REDIS_HOST || 'localhost',
    port: Number(env.REDIS_PORT) || 6379,
  };

  if (env.REDIS_PASSWORD) opcoes.password = env.REDIS_PASSWORD;
  if (env.REDIS_USERNAME) opcoes.username = env.REDIS_USERNAME;

  const db = Number(env.REDIS_DB);
  if (env.REDIS_DB && Number.isInteger(db) && db >= 0) opcoes.db = db;

  return opcoes;
}

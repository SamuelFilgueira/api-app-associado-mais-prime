import Redis from 'ioredis';
import { associadoSorteConfig } from 'src/associado-sorte/config/associado-sorte.config';

/**
 * Client Redis do limite de requisições do Associado da Sorte (mesmo molde de
 * `alloyal-redis.provider.ts`). Separado do client do BullMQ.
 */
export const SORTE_REDIS = 'SORTE_REDIS';

export const sorteRedisProvider = {
  provide: SORTE_REDIS,
  useFactory: (): Redis => {
    const { redis } = associadoSorteConfig();
    return new Redis({
      host: redis.host,
      port: redis.port,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
    });
  },
};

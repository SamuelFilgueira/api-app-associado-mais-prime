import Redis from 'ioredis';

/**
 * Client Redis do cache de categorias da Alloyal por base (mesmo molde de
 * `m7-redis.provider.ts`). Separado do client do BullMQ.
 */
export const ALLOYAL_REDIS = 'ALLOYAL_REDIS';

export const alloyalRedisProvider = {
  provide: ALLOYAL_REDIS,
  useFactory: (): Redis => {
    return new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
    });
  },
};

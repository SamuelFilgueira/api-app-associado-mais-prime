import Redis from 'ioredis';

/**
 * Client Redis dedicado ao cache de reverse geocode da M7 (mesmo molde de
 * `analytics-redis.provider.ts`). Separado do client do BullMQ para que uma
 * fila lenta não atrase o MGET do relatório e vice-versa.
 */
export const M7_REDIS = 'M7_REDIS';

export const m7RedisProvider = {
  provide: M7_REDIS,
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

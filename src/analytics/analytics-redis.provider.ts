import Redis from 'ioredis';

export const ANALYTICS_REDIS = 'ANALYTICS_REDIS';

export const analyticsRedisProvider = {
  provide: ANALYTICS_REDIS,
  useFactory: (): Redis => {
    return new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
    });
  },
};

import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { redisConnectionOptions } from 'src/config/redis.config';

/**
 * Cliente Redis compartilhado da aplicação (cache, rate limit, sessões de
 * vendor, travas). O BullMQ mantém as próprias conexões.
 *
 * Um cliente por processo: antes havia quatro providers de ioredis, um por
 * módulo, cada um com a sua conexão e a sua cópia das opções.
 */
export const REDIS_CLIENTE = Symbol('REDIS_CLIENTE');

const logger = new Logger('Redis');

export function criarClienteRedis(): Redis {
  const cliente = new Redis({
    ...redisConnectionOptions(),
    lazyConnect: true,
    // Comando falha rápido quando o Redis está fora: quem chama decide se
    // libera, bloqueia ou serve valor antigo. Sem fila offline, uma queda
    // não acumula comandos pendurados em memória.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    retryStrategy: (tentativa) => Math.min(tentativa * 200, 5_000),
  });

  cliente.on('error', (erro: Error) => {
    // Sem listener o ioredis derruba o processo com "Unhandled error event".
    logger.warn(`Conexão com o Redis: ${erro.message}`);
  });

  return cliente;
}

@Injectable()
class RedisCicloDeVida implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENTE) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENTE,
      useFactory: (): Redis => {
        const cliente = criarClienteRedis();
        // Conecta em segundo plano: o boot não depende do Redis estar de pé.
        cliente.connect().catch((erro: Error) => {
          logger.warn(`Redis indisponível no boot: ${erro.message}`);
        });
        return cliente;
      },
    },
    RedisCicloDeVida,
  ],
  exports: [REDIS_CLIENTE],
})
export class RedisModule {}

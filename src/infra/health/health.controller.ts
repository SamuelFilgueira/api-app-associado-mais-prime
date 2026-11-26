import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { appConfig } from 'src/config/app.config';
import { PrismaService } from 'src/database/prisma.service';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';

/** Prazo de cada dependência na sonda `ready`. */
const PRAZO_DEPENDENCIA_MS = 3_000;

type Situacao = 'ok' | 'error';

/**
 * Sondas de saúde (fora do prefixo `/api`):
 *
 * - `GET /health/live`: o processo está de pé e o event loop responde. Não
 *   toca em dependência — é a sonda do `HEALTHCHECK` do container: reiniciar
 *   o processo não conserta banco fora.
 * - `GET /health/ready`: MySQL e Redis respondem. Devolve 503 na falha; é a
 *   sonda do proxy e do deploy rolling (réplica só recebe tráfego pronta).
 * - `GET /health`: formato antigo, mantido para quem já monitora por ele
 *   (sempre 200, com `status: degraded` se o banco falhar).
 */
@Controller('health')
@LimiteDeTaxa('nenhuma')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENTE) private readonly redis: Redis,
  ) {}

  @Get()
  async check() {
    const database = await this.verificarBanco();

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: { database },
    };
  }

  @Get('live')
  live() {
    return {
      status: 'ok',
      role: appConfig().role,
      uptime: process.uptime(),
    };
  }

  @Get('ready')
  async ready() {
    const [database, redis] = await Promise.all([
      this.verificarBanco(),
      this.verificarRedis(),
    ]);
    const corpo = {
      status: database === 'ok' && redis === 'ok' ? 'ok' : 'unavailable',
      role: appConfig().role,
      checks: { database, redis },
    };

    if (corpo.status !== 'ok') {
      throw new ServiceUnavailableException(corpo);
    }
    return corpo;
  }

  private async verificarBanco(): Promise<Situacao> {
    try {
      await comPrazo(this.prisma.$queryRaw`SELECT 1`);
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async verificarRedis(): Promise<Situacao> {
    try {
      return (await comPrazo(this.redis.ping())) === 'PONG' ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  }
}

function comPrazo<T>(promessa: Promise<T>): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const prazo = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(
      () => rejeitar(new Error('prazo da sonda esgotado')),
      PRAZO_DEPENDENCIA_MS,
    );
  });
  return Promise.race([promessa, prazo]).finally(() => {
    if (temporizador) clearTimeout(temporizador);
  });
}

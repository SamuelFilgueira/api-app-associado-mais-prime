import { ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { HealthController } from 'src/infra/health/health.controller';

describe('HealthController', () => {
  const montar = (opcoes: { banco?: boolean; redis?: boolean } = {}) => {
    const prisma = {
      $queryRaw: jest.fn(() =>
        opcoes.banco === false
          ? Promise.reject(new Error('banco fora'))
          : Promise.resolve([{ 1: 1 }]),
      ),
    };
    const redis = {
      ping: jest.fn(() =>
        opcoes.redis === false
          ? Promise.reject(new Error('redis fora'))
          : Promise.resolve('PONG'),
      ),
    };
    return new HealthController(
      prisma as unknown as PrismaService,
      redis as unknown as Redis,
    );
  };

  it('live não toca em dependência', () => {
    const controller = montar({ banco: false, redis: false });
    expect(controller.live()).toMatchObject({ status: 'ok' });
  });

  it('ready: 200 com MySQL e Redis de pé', async () => {
    await expect(montar().ready()).resolves.toMatchObject({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok' },
    });
  });

  it.each([
    ['banco fora', { banco: false }, { database: 'error', redis: 'ok' }],
    ['Redis fora', { redis: false }, { database: 'ok', redis: 'error' }],
  ])('ready: 503 com %s', async (_caso, opcoes, checks) => {
    const erro = await montar(opcoes)
      .ready()
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ServiceUnavailableException);
    expect((erro as ServiceUnavailableException).getResponse()).toMatchObject({
      status: 'unavailable',
      checks,
    });
  });

  it('GET /health mantém o formato antigo: 200 e `degraded` com o banco fora', async () => {
    const corpo = await montar({ banco: false }).check();
    expect(corpo).toMatchObject({
      status: 'degraded',
      checks: { database: 'error' },
    });
    expect(Object.keys(corpo).sort()).toEqual([
      'checks',
      'status',
      'timestamp',
      'uptime',
    ]);
  });
});

import axios from 'axios';
import Redis from 'ioredis';
import { resetTenantConfigCache } from 'src/config/tenant.config';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { M7AuthService } from 'src/rastreamento/m7/services/m7-auth.service';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';
import { describeComRedis, limparChaves, redisDeTeste } from './ambiente';

/** Base exclusiva deste teste: as chaves no Redis não colidem com nada. */
const BASE = `ITM7${process.pid}`;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sessão da M7 no Redis REAL: duas réplicas (duas conexões) pedindo o token
 * ao mesmo tempo fazem UM login — a trava entre processos só existe com
 * Redis de verdade.
 */
describeComRedis('Redis real — sessão da M7 compartilhada', () => {
  const envOriginal = { ...process.env };
  let redisA: Redis;
  let redisB: Redis;
  let logins: number;

  const criar = (redis: Redis) =>
    new M7AuthService(
      new TenantCredentialsRegistry(),
      new VendorSessionStore(redis),
    );

  beforeAll(() => {
    process.env.TENANT_BASES = `${BASE}:_ITM7`;
    process.env.M7_API_BASE_URL = 'https://m7.teste.local/';
    process.env.MO7_TOKEN_ITM7 = 'token-de-teste';
    process.env.M07_CODIGO_ITM7 = 'codigo-de-teste';
    resetTenantConfigCache();
    redisA = redisDeTeste();
    redisB = redisDeTeste();
  });

  afterAll(async () => {
    await limparChaves(redisA, `sessao:m7:token:${BASE}`);
    await limparChaves(redisA, `sessao:m7:login:${BASE}`);
    await redisA.quit();
    await redisB.quit();
    process.env = { ...envOriginal };
    resetTenantConfigCache();
  });

  beforeEach(async () => {
    await limparChaves(redisA, `sessao:m7:token:${BASE}`);
    logins = 0;
    jest.spyOn(axios, 'post').mockImplementation(async () => {
      logins += 1;
      const numero = logins;
      await dormir(200); // o login demora: é a janela da corrida
      return {
        data: { sucesso: true, token: `sessao-${numero}`, expires_in: 3600 },
      };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('duas réplicas pedindo o token ao mesmo tempo fazem um login só', async () => {
    const a = criar(redisA);
    const b = criar(redisB);

    const tokens = await Promise.all([a.obterToken(BASE), b.obterToken(BASE)]);

    expect(logins).toBe(1);
    expect(tokens).toEqual(['sessao-1', 'sessao-1']);
  });

  it('a sessão guardada tem prazo e vale para uma réplica que sobe depois (boot sem login)', async () => {
    await criar(redisA).obterToken(BASE);
    const ttl = await redisA.ttl(`sessao:m7:token:${BASE}`);

    const nova = criar(redisB);
    await nova.onModuleInit();
    nova.onModuleDestroy();

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);
    expect(logins).toBe(1);
    await expect(nova.obterToken(BASE)).resolves.toBe('sessao-1');
  });

  it('as duas réplicas levam 401 com o mesmo token: uma renova, a outra adota', async () => {
    const a = criar(redisA);
    const b = criar(redisB);
    await a.obterToken(BASE);
    await b.obterToken(BASE);

    const sessoes = await Promise.all([
      a.renovar(BASE, 'sessao-1'),
      b.renovar(BASE, 'sessao-1'),
    ]);

    expect(logins).toBe(2);
    expect(sessoes.map((s) => s.token)).toEqual(['sessao-2', 'sessao-2']);
  });
});

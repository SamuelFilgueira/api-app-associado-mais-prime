import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';
import { ClubgasErroLogService } from 'src/integrations/clubgas/clubgas-erro-log.service';
import { PostosService } from 'src/postos/services/postos.service';
import { describeComRedis, limparChaves, redisDeTeste } from './ambiente';

/** Placa só deste processo: é ela que marca as chaves criadas pelo teste. */
const PLACA = `IT${process.pid}`.slice(0, 8);
const CHAVES = ['MAIS_PRIME', 'MAIS_PRIME_RS'].map(
  (base) => `${base}:postos:${PLACA}`,
);

const posto = (n: number) => ({ id: n, postoNome: `Posto ${n}` });

/** Lista de postos no cache do Redis de verdade, com o `CacheService` de verdade. */
describeComRedis('Redis real — cache da lista de postos', () => {
  let redis: Redis;
  let service: PostosService;
  const clubgasClient = { obterPostosMapa: jest.fn() };
  const prisma = {
    userVehicle: { findFirst: jest.fn().mockResolvedValue({ plate: PLACA }) },
    clubgasErroLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const buscar = (base: string, pagina: number, latitude = -22.9068) =>
    service.buscarPostos(
      latitude,
      -43.1729,
      42,
      'CHASSI1',
      pagina,
      base as never,
    );

  beforeAll(() => {
    redis = redisDeTeste();
    service = new PostosService(
      prisma as unknown as PrismaService,
      clubgasClient as unknown as ClubgasClient,
      new ClubgasErroLogService(prisma as unknown as PrismaService),
      new CacheService(redis),
    );
  });

  afterAll(async () => {
    for (const prefixo of CHAVES) await limparChaves(redis, prefixo);
    await redis.quit();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const prefixo of CHAVES) await limparChaves(redis, prefixo);
    clubgasClient.obterPostosMapa.mockImplementation((base: string) =>
      Promise.resolve({
        result: Array.from({ length: 12 }, (_, i) =>
          posto(base === 'MAIS_PRIME' ? i + 1 : 100 + i),
        ),
        pagination: { totalElements: 12 },
      }),
    );
  });

  it('três páginas da mesma busca: UMA ida ao Clubgas', async () => {
    const paginas = [
      await buscar('MAIS_PRIME', 1),
      await buscar('MAIS_PRIME', 2),
      await buscar('MAIS_PRIME', 3),
    ];

    expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(1);
    expect(
      paginas.map((p) => p.result.map((r) => (r as { id: number }).id)),
    ).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
      [11, 12],
    ]);
    expect(paginas[2].pagination).toEqual({
      totalElements: 12,
      pageSize: 5,
      pageNumber: 3,
      totalPages: 3,
    });
  });

  it('a chave nasce com prazo entre 13,5 e 16,5 minutos (15 min ± 10%)', async () => {
    await buscar('MAIS_PRIME', 1);

    const chaves = await redis.keys(`${CHAVES[0]}*`);
    expect(chaves).toEqual([`${CHAVES[0]}:-22.907:-43.173`]);
    const ttl = await redis.ttl(chaves[0]);
    expect(ttl).toBeGreaterThan(13 * 60);
    expect(ttl).toBeLessThanOrEqual(16.5 * 60 + 1);
  });

  it('base A não lê o cache da base B', async () => {
    const daPrime = await buscar('MAIS_PRIME', 1);
    const daRs = await buscar('MAIS_PRIME_RS', 1);
    const dePrimeDeNovo = await buscar('MAIS_PRIME', 1);

    expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
    expect((daPrime.result[0] as { id: number }).id).toBe(1);
    expect((daRs.result[0] as { id: number }).id).toBe(100);
    expect(dePrimeDeNovo.result).toEqual(daPrime.result);
  });

  it('dez buscas simultâneas da mesma lista fazem UMA ida ao Clubgas', async () => {
    clubgasClient.obterPostosMapa.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                result: [posto(1)],
                pagination: { totalElements: 1 },
              }),
            50,
          ),
        ),
    );

    await Promise.all(
      Array.from({ length: 10 }, () => buscar('MAIS_PRIME', 1)),
    );

    expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(1);
  });

  it('placa recusada pelo Clubgas não vai para o cache', async () => {
    clubgasClient.obterPostosMapa.mockResolvedValue({
      result: [],
      pagination: null,
    });

    await buscar('MAIS_PRIME', 1);
    await buscar('MAIS_PRIME', 1);

    expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
    expect(await redis.keys(`${CHAVES[0]}*`)).toEqual([]);
  });
});

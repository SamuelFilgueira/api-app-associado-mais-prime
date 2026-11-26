import { M7_GEOCODE_CONFIG } from 'src/config/m7-geocode.config';
import { PrismaService } from 'src/database/prisma.service';
import type Redis from 'ioredis';
import { M7ReverseGeocodeService } from './m7-reverse-geocode.service';

const BASE = 'MAIS_PRIME' as const;

const redisVazio = {
  mget: (...chaves: string[]) => Promise.resolve(chaves.map(() => null)),
  pipeline: () => ({
    expire: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  }),
} as unknown as Redis;

const linhaDeRua = [
  {
    name: 'Rua Teste',
    name_pt: null,
    type: 'residential',
    postcode: null,
    admin_level: null,
    address_suburb: 'Bairro Teste',
    address_city: null,
  },
];

/**
 * Proteção do pool de conexões e do cache em memória do reverse geocode.
 */
describe('M7ReverseGeocodeService — pool e cache sob falha', () => {
  it('o teto global deriva do pool: reserva 30% e divide por 3 conexões por consulta', () => {
    // Sem PRISMA_CONNECTION_LIMIT no ambiente de teste o pool é o padrão (40):
    // reserva 12, sobram 28, 3 conexões por consulta → 9.
    expect(M7_GEOCODE_CONFIG.consultasSimultaneas).toBe(9);
  });

  it('falha de pool (P2024) devolve o fallback SEM guardar: a próxima tentativa consulta de novo', async () => {
    let falhar = true;
    const queryRawUnsafe = jest.fn((sql: string) => {
      if (falhar) {
        return Promise.reject(
          Object.assign(new Error('Timed out fetching a new connection'), {
            code: 'P2024',
          }),
        );
      }
      return Promise.resolve(
        sql.includes(`class = 'highway'`) ? linhaDeRua : [],
      );
    });
    const service = new M7ReverseGeocodeService(
      { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService,
      redisVazio,
    );

    const comFalha = await service.reverseGeocodeCoordenada(
      '-22.9',
      '-43.2',
      BASE,
    );
    expect(comFalha).toBe('-22.9, -43.2');

    falhar = false;
    const depois = await service.reverseGeocodeCoordenada(
      '-22.9',
      '-43.2',
      BASE,
    );

    expect(depois).toContain('Rua Teste');
  });

  it('"sem correspondência" de verdade continua cacheado em memória', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const service = new M7ReverseGeocodeService(
      { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService,
      redisVazio,
    );

    await service.reverseGeocodeCoordenada('-10.5', '-40.5', BASE);
    const chamadas = queryRawUnsafe.mock.calls.length;
    await service.reverseGeocodeCoordenada('-10.5', '-40.5', BASE);

    expect(chamadas).toBeGreaterThan(0);
    expect(queryRawUnsafe.mock.calls.length).toBe(chamadas);
  });

  it('tabela do Nominatim inexistente não conta como falha de banco (resultado é cacheado)', async () => {
    const queryRawUnsafe = jest.fn().mockRejectedValue(
      Object.assign(new Error("Table 'nominatim_rj.placex' doesn't exist"), {
        code: 'P2010',
      }),
    );
    const service = new M7ReverseGeocodeService(
      { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService,
      redisVazio,
    );

    await service.reverseGeocodeCoordenada('-11.5', '-41.5', BASE);
    const chamadas = queryRawUnsafe.mock.calls.length;
    await service.reverseGeocodeCoordenada('-11.5', '-41.5', BASE);

    expect(queryRawUnsafe.mock.calls.length).toBe(chamadas);
  });

  it('muitas coordenadas ao mesmo tempo: as consultas em curso respeitam o teto global', async () => {
    let emCurso = 0;
    let pico = 0;
    const queryRawUnsafe = jest.fn(async () => {
      emCurso += 1;
      pico = Math.max(pico, emCurso);
      await new Promise((r) => setTimeout(r, 5));
      emCurso -= 1;
      return [];
    });
    const service = new M7ReverseGeocodeService(
      { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService,
      redisVazio,
    );

    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        service.reverseGeocodeCoordenada(
          (-20 - i * 0.01).toFixed(2),
          (-43 - i * 0.01).toFixed(2),
          BASE,
        ),
      ),
    );

    // Cada consulta roda até 3 queries em paralelo.
    expect(pico).toBeLessThanOrEqual(
      M7_GEOCODE_CONFIG.consultasSimultaneas * 3,
    );
    expect(pico).toBeGreaterThan(3);
  });
});

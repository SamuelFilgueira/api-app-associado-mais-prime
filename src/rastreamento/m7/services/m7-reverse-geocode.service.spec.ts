import { M7_GEOCODE_CONFIG } from 'src/config/m7-geocode.config';
import { PrismaService } from 'src/database/prisma.service';
import type Redis from 'ioredis';
import { M7PontoHistoricoRaw } from '../interfaces/m7-historico.interface';
import { M7ReverseGeocodeService } from './m7-reverse-geocode.service';

type ConfigMutavel = {
  -readonly [K in keyof typeof M7_GEOCODE_CONFIG]: number;
};
const config = M7_GEOCODE_CONFIG as unknown as ConfigMutavel;

const BASE = 'MAIS_PRIME' as const;

/** Simula o placex: só a query de rua (class = 'highway') retorna linha. */
function criarPrismaMock(opcoes?: { semMatch?: boolean; atrasoMs?: number }) {
  const queryRawUnsafe = jest.fn(async (sql: string) => {
    if (opcoes?.atrasoMs) {
      await new Promise((r) => setTimeout(r, opcoes.atrasoMs));
    }
    if (opcoes?.semMatch) return [];
    if (sql.includes(`class = 'highway'`)) {
      return [
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
    }
    return [];
  });
  return {
    $queryRawUnsafe: queryRawUnsafe,
  } as unknown as PrismaService & { $queryRawUnsafe: jest.Mock };
}

function criarRedisMock(mgetImpl?: (...chaves: string[]) => Promise<unknown>) {
  const pipeline = {
    expire: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };
  const redis = {
    mget: jest.fn(
      mgetImpl ??
        ((...chaves: string[]) =>
          Promise.resolve(chaves.map(() => null as string | null))),
    ),
    pipeline: jest.fn(() => pipeline),
  };
  return {
    redis: redis as unknown as Redis,
    mocks: { ...redis, pipelineMock: pipeline },
  };
}

function pontoRaw(
  lat: number,
  lon: number,
  cidade = 'Rio de Janeiro,RJ',
  seg = 0,
): M7PontoHistoricoRaw {
  return {
    identificador: 'ABC1D23',
    data_gps: `2026-09-01 12:00:${String(seg).padStart(2, '0')}`,
    latitude: lat,
    longitude: lon,
    velocidade: 10,
    cidade,
  };
}

const esperarPersistencia = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe('M7ReverseGeocodeService', () => {
  const defaults = { ...M7_GEOCODE_CONFIG };

  afterEach(() => {
    Object.assign(config, defaults);
  });

  describe('herança espacial (prepararPontosContestacao)', () => {
    it('pontos a até 20 m da âncora herdam a chave; acima viram nova âncora', () => {
      const service = new M7ReverseGeocodeService(
        criarPrismaMock(),
        criarRedisMock().redis,
      );
      const contexto = service.criarContexto(BASE);
      const base = -22.9;
      const pontos = [
        pontoRaw(base, -43.2), // A (âncora)
        pontoRaw(base + 0.00005, -43.2), // ~5,5 m de A
        pontoRaw(base + 0.00013, -43.2), // ~14,5 m de A
        pontoRaw(base + 0.0003, -43.2), // ~33 m de A → nova âncora D
        pontoRaw(base + 0.00034, -43.2), // ~4,5 m de D
      ];

      const preparo = service.prepararPontosContestacao(pontos, contexto);

      expect(preparo.pontos).toHaveLength(5);
      const keyA = preparo.pontos[0].key;
      const keyD = preparo.pontos[3].key;
      expect(keyA).not.toBe(keyD);
      expect(preparo.pontos.map((p) => p.key)).toEqual([
        keyA,
        keyA,
        keyA,
        keyD,
        keyD,
      ]);
      expect(preparo.ancoras.map((a) => a.key)).toEqual([keyA, keyD]);
      expect(contexto.estatisticas).toMatchObject({
        pontos: 5,
        coordUnicas: 5,
        ancoras: 2,
        herdados: 3,
      });
    });

    it('revisita ao mesmo local horas depois reaproveita a âncora original', () => {
      const service = new M7ReverseGeocodeService(
        criarPrismaMock(),
        criarRedisMock().redis,
      );
      const contexto = service.criarContexto(BASE);
      const pontos = [
        pontoRaw(-22.9, -43.2),
        pontoRaw(-22.95, -43.25), // longe
        pontoRaw(-22.90004, -43.20004), // ~6 m do primeiro
      ];

      const preparo = service.prepararPontosContestacao(pontos, contexto);

      expect(preparo.pontos[2].key).toBe(preparo.pontos[0].key);
      expect(preparo.ancoras).toHaveLength(2);
    });

    it('não herda entre cidades diferentes', () => {
      const service = new M7ReverseGeocodeService(
        criarPrismaMock(),
        criarRedisMock().redis,
      );
      const contexto = service.criarContexto(BASE);
      const pontos = [
        pontoRaw(-22.9, -43.2, 'Rio de Janeiro,RJ'),
        pontoRaw(-22.90004, -43.2, 'Niterói,RJ'),
      ];

      const preparo = service.prepararPontosContestacao(pontos, contexto);

      expect(preparo.ancoras).toHaveLength(2);
      expect(contexto.estatisticas.herdados).toBe(0);
    });

    it('com herança desligada cada coordenada única é uma âncora', () => {
      config.herancaMetros = 0;
      const service = new M7ReverseGeocodeService(
        criarPrismaMock(),
        criarRedisMock().redis,
      );
      const contexto = service.criarContexto(BASE);
      const pontos = [
        pontoRaw(-22.9, -43.2),
        pontoRaw(-22.90001, -43.2),
        pontoRaw(-22.9, -43.2), // duplicata exata
      ];

      const preparo = service.prepararPontosContestacao(pontos, contexto);

      expect(preparo.ancoras).toHaveLength(2);
      expect(preparo.pontos[2].key).toBe(preparo.pontos[0].key);
    });
  });

  describe('cache em memória', () => {
    it('reaproveita o resultado com o mesmo override de cidade e consulta de novo com cidade diferente', async () => {
      const prisma = criarPrismaMock();
      const service = new M7ReverseGeocodeService(
        prisma,
        criarRedisMock().redis,
      );

      const primeiro = await service.reverseGeocodeCoordenada(
        '-22.900000',
        '-43.200000',
        BASE,
        'Rio de Janeiro',
      );
      const chamadasAposPrimeiro = prisma.$queryRawUnsafe.mock.calls.length;
      expect(chamadasAposPrimeiro).toBeGreaterThan(0);
      expect(primeiro).toBe('Rua Teste, Bairro Teste, Rio de Janeiro, RJ');

      const segundo = await service.reverseGeocodeCoordenada(
        '-22.900000',
        '-43.200000',
        BASE,
        'Rio de Janeiro',
      );
      expect(segundo).toBe(primeiro);
      expect(prisma.$queryRawUnsafe.mock.calls.length).toBe(
        chamadasAposPrimeiro,
      );

      const terceiro = await service.reverseGeocodeCoordenada(
        '-22.900000',
        '-43.200000',
        BASE,
        'Niterói',
      );
      expect(terceiro).toBe('Rua Teste, Bairro Teste, Niterói, RJ');
      expect(prisma.$queryRawUnsafe.mock.calls.length).toBeGreaterThan(
        chamadasAposPrimeiro,
      );
    });
  });

  describe('cache Redis', () => {
    it('hits saem do lote, têm TTL renovado e misses são gravados com EX', async () => {
      const { redis, mocks } = criarRedisMock((...chaves) =>
        Promise.resolve(
          chaves.map((_, i) => (i === 1 ? 'Endereço do cache' : null)),
        ),
      );
      const prisma = criarPrismaMock();
      const service = new M7ReverseGeocodeService(prisma, redis);
      const contexto = service.criarContexto(BASE);
      const preparo = service.prepararPontosContestacao(
        [pontoRaw(-22.9, -43.2), pontoRaw(-22.95, -43.25)],
        contexto,
      );

      const hits = await service.carregarCacheRedis(preparo.ancoras, contexto);
      expect(hits).toBe(1);
      expect(contexto.resolvidos.get(preparo.ancoras[1].key)).toBe(
        'Endereço do cache',
      );
      expect(mocks.pipelineMock.expire).toHaveBeenCalledTimes(1);
      expect(mocks.pipelineMock.expire.mock.calls[0][1]).toBe(
        M7_GEOCODE_CONFIG.redisTtlSeg,
      );

      await service.resolverEnderecos(preparo.ancoras, contexto);
      await esperarPersistencia();

      expect(contexto.estatisticas).toMatchObject({
        cacheRedis: 1,
        geocodadas: 1,
      });
      expect(mocks.pipelineMock.set).toHaveBeenCalledTimes(1);
      const [chave, valor, modo, ttl] = mocks.pipelineMock.set.mock.calls[0];
      expect(chave).toMatch(/^m7:revgeo:v1:-229000:-432000:rio-de-janeiro$/);
      expect(valor).toBe('Rua Teste, Bairro Teste, Rio de Janeiro, RJ');
      expect(modo).toBe('EX');
      expect(ttl).toBe(M7_GEOCODE_CONFIG.redisTtlSeg);
    });

    it('não grava o fallback "lat, lon" quando o banco não tem correspondência', async () => {
      const { redis, mocks } = criarRedisMock();
      const service = new M7ReverseGeocodeService(
        criarPrismaMock({ semMatch: true }),
        redis,
      );
      const contexto = service.criarContexto(BASE);
      const preparo = service.prepararPontosContestacao(
        [pontoRaw(-22.9, -43.2)],
        contexto,
      );

      await service.carregarCacheRedis(preparo.ancoras, contexto);
      await service.resolverEnderecos(preparo.ancoras, contexto);
      await esperarPersistencia();

      expect(contexto.resolvidos.get(preparo.ancoras[0].key)).toBe(
        '-22.900000, -43.200000',
      );
      expect(contexto.estatisticas.semMatch).toBe(1);
      expect(mocks.pipelineMock.set).not.toHaveBeenCalled();
    });

    it('Redis indisponível não impede o geocode', async () => {
      const { redis } = criarRedisMock(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );
      const service = new M7ReverseGeocodeService(criarPrismaMock(), redis);
      const contexto = service.criarContexto(BASE);
      const preparo = service.prepararPontosContestacao(
        [pontoRaw(-22.9, -43.2)],
        contexto,
      );

      const hits = await service.carregarCacheRedis(preparo.ancoras, contexto);
      await service.resolverEnderecos(preparo.ancoras, contexto);

      expect(hits).toBe(0);
      expect(contexto.estatisticas.redisIndisponivel).toBe(true);
      expect(contexto.resolvidos.get(preparo.ancoras[0].key)).toBe(
        'Rua Teste, Bairro Teste, Rio de Janeiro, RJ',
      );
    });
  });

  describe('pool de workers e orçamento', () => {
    it('nunca mantém mais geocodes em voo do que a concorrência configurada', async () => {
      config.concorrencia = 4;
      const service = new M7ReverseGeocodeService(
        criarPrismaMock(),
        criarRedisMock().redis,
      );
      let emVoo = 0;
      let maxEmVoo = 0;
      jest
        .spyOn(
          service as unknown as { resolverCoordenada: () => Promise<unknown> },
          'resolverCoordenada',
        )
        .mockImplementation(async () => {
          emVoo += 1;
          maxEmVoo = Math.max(maxEmVoo, emVoo);
          await new Promise((r) => setTimeout(r, 5));
          emVoo -= 1;
          return { endereco: 'Rua X, Cidade, RJ', origem: 'banco' };
        });

      const contexto = service.criarContexto(BASE);
      const pontos = Array.from({ length: 20 }, (_, i) =>
        pontoRaw(-22.9 + i * 0.01, -43.2),
      );
      const preparo = service.prepararPontosContestacao(pontos, contexto);

      await service.resolverEnderecos(preparo.ancoras, contexto);

      expect(maxEmVoo).toBeLessThanOrEqual(4);
      expect(maxEmVoo).toBeGreaterThan(1);
      expect(contexto.resolvidos.size).toBe(20);
      expect(contexto.estatisticas.geocodadas).toBe(20);
    });

    it('com orçamento esgotado nenhuma âncora vai ao banco e todas recebem coordenadas', async () => {
      const prisma = criarPrismaMock();
      const service = new M7ReverseGeocodeService(
        prisma,
        criarRedisMock().redis,
      );
      const contexto = service.criarContexto(BASE);
      contexto.budgetMs = 0;
      contexto.inicioMs = Date.now() - 10;
      const preparo = service.prepararPontosContestacao(
        [pontoRaw(-22.9, -43.2), pontoRaw(-22.95, -43.25)],
        contexto,
      );

      await service.resolverEnderecos(preparo.ancoras, contexto);

      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(contexto.estatisticas.porOrcamento).toBe(2);
      expect(contexto.resolvidos.get(preparo.ancoras[0].key)).toBe(
        '-22.900000, -43.200000',
      );
    });
  });

  describe('montarPontosContestacao (fluxo completo, V1)', () => {
    it('devolve todas as linhas com endereço e preserva a ordem', async () => {
      const service = new M7ReverseGeocodeService(
        criarPrismaMock(),
        criarRedisMock().redis,
      );
      const pontos = [
        pontoRaw(-22.9, -43.2, 'Rio de Janeiro,RJ', 0),
        pontoRaw(-22.90004, -43.2, 'Rio de Janeiro,RJ', 1),
        pontoRaw(-22.95, -43.25, 'Rio de Janeiro,RJ', 2),
      ];

      const linhas = await service.montarPontosContestacao(pontos, BASE);

      expect(linhas).toHaveLength(3);
      expect(linhas.map((l) => l.dataGps)).toEqual(
        pontos.map((p) => p.data_gps),
      );
      expect(linhas[1].latitude).toBe('-22.900040');
      expect(linhas[1].endereco).toBe(linhas[0].endereco);
      expect(linhas[2].endereco).toBe(
        'Rua Teste, Bairro Teste, Rio de Janeiro, RJ',
      );
    });
  });
});

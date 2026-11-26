import Redis from 'ioredis';
import {
  CacheService,
  TAMANHO_MAXIMO_DO_VALOR,
} from 'src/infra/cache/cache.service';
import { LimitadorService } from 'src/infra/rate-limit/limitador.service';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { describeComRedis, limparChaves, redisDeTeste } from './ambiente';

const PREFIXO = `it-${process.pid}`;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeComRedis('Redis real — limitador, sessões de vendor e cache', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = redisDeTeste();
  });

  afterAll(async () => {
    await limparChaves(redis, PREFIXO);
    await limparChaves(redis, 'sessao:it-');
    await redis.quit();
  });

  describe('LimitadorService (script Lua)', () => {
    it('conta de forma atômica e a chave sempre nasce com expiração', async () => {
      const limitador = new LimitadorService(redis);
      const chave = `${PREFIXO}:rl:a`;

      const resultados = await Promise.all(
        Array.from({ length: 20 }, () => limitador.consumir(chave, 60)),
      );

      expect(resultados.map((r) => r.total).sort((x, y) => x - y)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      expect(await redis.ttl(chave)).toBeGreaterThan(0);
    });

    it('conserta chave órfã sem expiração (defeito do INCR + EXPIRE antigos)', async () => {
      const limitador = new LimitadorService(redis);
      const chave = `${PREFIXO}:rl:orfa`;
      await redis.set(chave, '50'); // sem TTL: ficaria em 429 para sempre

      const { total, restanteMs } = await limitador.consumir(chave, 30);

      expect(total).toBe(51);
      expect(restanteMs).toBeGreaterThan(0);
      expect(await redis.ttl(chave)).toBeGreaterThan(0);
    });

    it('consulta sem contar não cria a chave', async () => {
      const limitador = new LimitadorService(redis);
      const chave = `${PREFIXO}:rl:consulta`;

      await expect(limitador.consumir(chave, 60, false)).resolves.toEqual({
        total: 0,
        restanteMs: 0,
      });
      expect(await redis.exists(chave)).toBe(0);
    });

    it('vagas simultâneas: ocupa, mede e devolve', async () => {
      const limitador = new LimitadorService(redis);
      const chave = `${PREFIXO}:rl:vaga`;

      expect(await limitador.ocuparVaga(chave, 60)).toBe(1);
      expect(await limitador.ocuparVaga(chave, 60)).toBe(2);
      await limitador.liberarVaga(chave);
      await limitador.liberarVaga(chave);
      expect(await redis.exists(chave)).toBe(0);
    });
  });

  describe('VendorSessionStore', () => {
    const vendor = `it-${process.pid}`;

    it('dois processos enxergam a mesma sessão', async () => {
      const a = new VendorSessionStore(redis);
      const outro = redisDeTeste();
      const b = new VendorSessionStore(outro);

      await a.gravar(vendor, 'MAIS_PRIME:0', 'token-1', 60);

      await expect(b.ler(vendor, 'MAIS_PRIME:0')).resolves.toBe('token-1');
      await outro.quit();
    });

    it('apagar com `seValorFor` não derruba a sessão mais nova', async () => {
      const store = new VendorSessionStore(redis);
      await store.gravar(vendor, 'x', 'token-novo', 60);

      await store.apagar(vendor, 'x', 'token-antigo');
      await expect(store.ler(vendor, 'x')).resolves.toBe('token-novo');

      await store.apagar(vendor, 'x', 'token-novo');
      await expect(store.ler(vendor, 'x')).resolves.toBeNull();
    });

    it('comTrava: logins concorrentes de processos diferentes rodam um de cada vez', async () => {
      const outro = redisDeTeste();
      const stores = [
        new VendorSessionStore(redis),
        new VendorSessionStore(outro),
      ];
      let emCurso = 0;
      let maximo = 0;
      let logins = 0;

      const login = (store: VendorSessionStore) =>
        store.comTrava(vendor, 'login:MAIS_PRIME:0', async () => {
          const pronta = await store.ler(vendor, 'sessao-login');
          if (pronta) return pronta;
          emCurso += 1;
          maximo = Math.max(maximo, emCurso);
          logins += 1;
          await dormir(120);
          await store.gravar(vendor, 'sessao-login', `token-${logins}`, 60);
          emCurso -= 1;
          return `token-${logins}`;
        });

      const tokens = await Promise.all([
        login(stores[0]),
        login(stores[1]),
        login(stores[0]),
        login(stores[1]),
      ]);

      expect(maximo).toBe(1);
      expect(logins).toBe(1);
      expect(new Set(tokens)).toEqual(new Set(['token-1']));
      await outro.quit();
    });

    it('lerVarios devolve na ordem pedida, com null para o que não existe', async () => {
      const store = new VendorSessionStore(redis);
      await store.gravar(vendor, 'm:1', 'a', 60);
      await store.gravar(vendor, 'm:3', 'c', 60);

      await expect(
        store.lerVarios(vendor, ['m:1', 'm:2', 'm:3']),
      ).resolves.toEqual(['a', null, 'c']);
    });
  });

  describe('CacheService', () => {
    const base = `${PREFIXO}-BASE`;
    const opcoes = (carregar: () => Promise<unknown>, extra = {}) => ({
      base,
      chave: 'sga:associado:1',
      recurso: 'teste',
      ttlSeg: 1,
      carregar,
      ...extra,
    });

    beforeEach(async () => {
      await limparChaves(redis, base);
    });

    it('segunda leitura vem do cache, com a chave prefixada pela base', async () => {
      const cache = new CacheService(redis);
      const carregar = jest.fn().mockResolvedValue({ nome: 'Fulano' });

      const primeira = await cache.obter(opcoes(carregar));
      const segunda = await cache.obter(opcoes(carregar));

      expect(primeira.fonte).toBe('origem');
      expect(segunda).toMatchObject({
        fonte: 'cache',
        valor: { nome: 'Fulano' },
      });
      expect(carregar).toHaveBeenCalledTimes(1);
      expect(await redis.exists(`${base}:sga:associado:1`)).toBe(1);
      expect(await redis.ttl(`${base}:sga:associado:1`)).toBeGreaterThan(0);
    });

    it('leituras simultâneas fazem uma única ida à origem', async () => {
      const cache = new CacheService(redis);
      const carregar = jest.fn(async () => {
        await dormir(80);
        return 'valor';
      });

      const leituras = await Promise.all(
        Array.from({ length: 10 }, () => cache.obter(opcoes(carregar))),
      );

      expect(carregar).toHaveBeenCalledTimes(1);
      expect(leituras.every((l) => l.valor === 'valor')).toBe(true);
    });

    it('vencido e origem fora: serve o valor antigo com a data da leitura', async () => {
      const cache = new CacheService(redis);
      const antigo = { antigoPorSeg: 60 };
      await cache.obter(opcoes(() => Promise.resolve('v1'), antigo));
      await dormir(1_250);

      const leitura = await cache.obter(
        opcoes(() => Promise.reject(new Error('Hinova fora')), antigo),
      );

      expect(leitura).toMatchObject({ fonte: 'antigo', valor: 'v1' });
      expect(Date.now() - leitura.atualizadoEm.getTime()).toBeGreaterThan(
        1_000,
      );
    });

    it('vencido sem janela de valor antigo: o erro da origem sobe', async () => {
      const cache = new CacheService(redis);
      await cache.obter(opcoes(() => Promise.resolve('v1')));
      await dormir(1_250);

      await expect(
        cache.obter(opcoes(() => Promise.reject(new Error('Hinova fora')))),
      ).rejects.toThrow('Hinova fora');
    });

    it('`guardarSe` impede cachear resposta de erro que veio como sucesso', async () => {
      const cache = new CacheService(redis);
      const carregar = jest.fn().mockResolvedValue({ status: 403 });
      const naoGuardar = {
        guardarSe: (v: unknown) => (v as { status: number }).status < 400,
      };

      await cache.obter(opcoes(carregar, naoGuardar));
      await cache.obter(opcoes(carregar, naoGuardar));

      expect(carregar).toHaveBeenCalledTimes(2);
    });

    it('invalidar apaga a chave da base', async () => {
      const cache = new CacheService(redis);
      const carregar = jest.fn().mockResolvedValue('v');
      await cache.obter(opcoes(carregar));

      await cache.invalidar(base, 'sga:associado:1');
      await cache.obter(opcoes(carregar));

      expect(carregar).toHaveBeenCalledTimes(2);
    });

    it('valor acima do teto é devolvido, mas não é guardado (o Redis é o mesmo das filas)', async () => {
      const cache = new CacheService(redis);
      const enorme = 'x'.repeat(TAMANHO_MAXIMO_DO_VALOR + 1);
      const carregar = jest.fn().mockResolvedValue(enorme);

      const primeira = await cache.obter(opcoes(carregar));
      const segunda = await cache.obter(opcoes(carregar));

      expect(primeira.valor).toBe(enorme);
      expect(segunda.fonte).toBe('origem');
      expect(carregar).toHaveBeenCalledTimes(2);
      expect(await redis.exists(`${base}:sga:associado:1`)).toBe(0);
    });
  });
});

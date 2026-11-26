import Redis from 'ioredis';
import { AlloyalCatalogoService } from 'src/beneficios/services/alloyal-catalogo.service';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { CacheService } from 'src/infra/cache/cache.service';
import {
  AlloyalGateway,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';
import { describeComRedis, limparChaves, redisDeTeste } from './ambiente';

/**
 * Cache do catálogo da Alloyal sobre um Redis REAL: o que o teste de unidade
 * (Redis em memória) não prova — a expiração de verdade de cada chave (o
 * Redis das filas roda em `noeviction`) e o compartilhamento entre processos.
 *
 * As "bases" daqui são marcadores próprios do teste: toda chave criada
 * começa por `it-alloyal-<pid>` e é apagada no fim.
 */
const MARCADOR = `it-alloyal-${process.pid}`;
const BASE_A = `${MARCADOR}-a`;
const BASE_B = `${MARCADOR}-b`;
const HORA = 3_600;

describeComRedis('Redis real — cache do catálogo da Alloyal', () => {
  const sessao: SessaoAlloyal = { uid: 'u', client: 'c', accessToken: 't' };
  const categorias = [
    { id: 1, title: 'Alimentação', icon: 'a.png', subcategories: [] },
    { id: 2, title: 'Automotivo', icon: 'b.png', subcategories: [] },
  ];
  const organizacao = { id: 10, name: 'Loja', favorited: true };

  let redis: Redis;
  let alloyal: {
    listarCategorias: jest.Mock;
    listarDestaquesOnline: jest.Mock;
    listarOrganizacoes: jest.Mock;
  };

  /** Um "processo" da API: instâncias próprias, mesmo Redis. */
  const processo = () => {
    const cache = new CacheService(redis);
    const painel = new AlloyalCategoriesCacheService(cache);
    const catalogo = new AlloyalCatalogoService(
      alloyal as unknown as AlloyalGateway,
      cache,
      painel,
    );
    return { catalogo, painel };
  };

  beforeAll(() => {
    redis = redisDeTeste();
  });

  beforeEach(async () => {
    await limparChaves(redis, MARCADOR);
    alloyal = {
      listarCategorias: jest.fn().mockResolvedValue(categorias),
      listarDestaquesOnline: jest.fn().mockResolvedValue([organizacao]),
      listarOrganizacoes: jest.fn().mockResolvedValue([organizacao]),
    };
  });

  afterAll(async () => {
    await limparChaves(redis, MARCADOR);
    await redis.quit();
  });

  it('a segunda leitura não chama a Alloyal, nem em outro processo', async () => {
    const a = processo();
    const b = processo();

    await expect(a.catalogo.categorias(BASE_A, sessao)).resolves.toEqual(
      categorias,
    );
    await expect(a.catalogo.categorias(BASE_A, sessao)).resolves.toEqual(
      categorias,
    );
    await expect(b.catalogo.categorias(BASE_A, sessao)).resolves.toEqual(
      categorias,
    );

    expect(alloyal.listarCategorias).toHaveBeenCalledTimes(1);
  });

  it('a base A não lê o cache da base B', async () => {
    const { catalogo } = processo();
    const daB = [{ id: 9, title: 'Só na B' }];
    alloyal.listarCategorias
      .mockResolvedValueOnce(categorias)
      .mockResolvedValueOnce(daB);

    await catalogo.categorias(BASE_A, sessao);

    await expect(catalogo.categorias(BASE_B, sessao)).resolves.toEqual(daB);
    await expect(catalogo.categorias(BASE_A, sessao)).resolves.toEqual(
      categorias,
    );
    expect(alloyal.listarCategorias).toHaveBeenCalledTimes(2);
  });

  it('toda chave nasce com expiração: 1 a 6 h para o app, 7 dias para o painel', async () => {
    const { catalogo } = processo();

    await catalogo.categorias(BASE_A, sessao);
    await catalogo.destaquesOnline(BASE_A, sessao);
    await catalogo.organizacoes(BASE_A, sessao, {});
    await catalogo.organizacoes(BASE_A, sessao, {
      page: '2',
      organization_type: 'online',
    });

    const ttl = async (sufixo: string) =>
      redis.ttl(`${BASE_A}:alloyal:catalogo:${sufixo}`);
    // Jitter de ±10% sobre o prazo de cada recurso.
    const entre = (valor: number, prazo: number) => {
      expect(valor).toBeGreaterThan(prazo * 0.89);
      expect(valor).toBeLessThanOrEqual(Math.ceil(prazo * 1.1));
    };

    entre(await ttl('categorias'), 6 * HORA);
    entre(await ttl('destaques_online'), 3 * HORA);
    entre(await ttl('organizacoes:todos:p1'), 1 * HORA);
    entre(await ttl('organizacoes:online:p2'), 1 * HORA);
    entre(await ttl('categorias_painel'), 7 * 24 * HORA);

    // Nenhuma chave do catálogo sem prazo (-1) no Redis das filas.
    const chaves = await redis.keys(`${BASE_A}:*`);
    expect(chaves.sort()).toEqual(
      [
        'categorias',
        'categorias_painel',
        'destaques_online',
        'organizacoes:online:p2',
        'organizacoes:todos:p1',
      ].map((sufixo) => `${BASE_A}:alloyal:catalogo:${sufixo}`),
    );
    for (const chave of chaves) {
      expect(await redis.ttl(chave)).toBeGreaterThan(0);
    }
  });

  it('consulta com coordenada ou busca, erro e lista vazia não criam chave', async () => {
    const { catalogo } = processo();
    alloyal.listarDestaquesOnline
      .mockRejectedValueOnce(new Error('Alloyal fora'))
      .mockResolvedValueOnce([]);

    await catalogo.organizacoes(BASE_A, sessao, { lat: '-22.9', lng: '-43.1' });
    await catalogo.organizacoes(BASE_A, sessao, { search: 'pizza' });
    await expect(catalogo.destaquesOnline(BASE_A, sessao)).rejects.toThrow(
      'Alloyal fora',
    );
    await expect(catalogo.destaquesOnline(BASE_A, sessao)).resolves.toEqual([]);

    expect(await redis.keys(`${BASE_A}:*`)).toEqual([]);
  });

  it('o painel lê em outro processo o resumo que o app gravou; regravar renova o prazo', async () => {
    const app = processo();
    const painel = processo().painel;

    await expect(painel.obterPorBase([BASE_A, BASE_B])).resolves.toEqual({
      [BASE_A]: [],
      [BASE_B]: [],
    });
    // Ler sem valor guardado não cria chave.
    expect(await redis.keys(`${MARCADOR}*`)).toEqual([]);

    await app.catalogo.categorias(BASE_A, sessao);

    await expect(painel.obterPorBase([BASE_A, BASE_B])).resolves.toEqual({
      [BASE_A]: [
        { id: 1, title: 'Alimentação' },
        { id: 2, title: 'Automotivo' },
      ],
      [BASE_B]: [],
    });

    const chave = `${BASE_A}:alloyal:catalogo:categorias_painel`;
    await redis.expire(chave, 100);
    await app.painel.armazenar(BASE_A, [{ id: 3, title: 'Nova' }]);

    await expect(painel.obter(BASE_A)).resolves.toEqual([
      { id: 3, title: 'Nova' },
    ]);
    expect(await redis.ttl(chave)).toBeGreaterThan(6 * 24 * HORA);
  });

  it('o que fica guardado é o JSON já mapeado: nada do usuário nem da sessão dele', async () => {
    const { catalogo } = processo();
    const sessaoDoUsuario: SessaoAlloyal = {
      uid: 'uid-do-usuario@teste.local',
      client: 'client-do-usuario',
      accessToken: 'token-do-usuario',
    };

    await catalogo.categorias(BASE_A, sessaoDoUsuario);
    await catalogo.destaquesOnline(BASE_A, sessaoDoUsuario);
    await catalogo.organizacoes(BASE_A, sessaoDoUsuario, {});

    const chaves = await redis.keys(`${BASE_A}:*`);
    expect(chaves).toHaveLength(4);
    for (const chave of chaves) {
      const guardado = await redis.get(chave);
      expect(guardado).not.toContain('favorited');
      expect(guardado).not.toContain('uid-do-usuario');
      expect(guardado).not.toContain('client-do-usuario');
      expect(guardado).not.toContain('token-do-usuario');
    }
    expect(
      await redis.get(`${BASE_A}:alloyal:catalogo:organizacoes:todos:p1`),
    ).toContain('[{"id":10,"name":"Loja","distance_km":0}]');
  });
});

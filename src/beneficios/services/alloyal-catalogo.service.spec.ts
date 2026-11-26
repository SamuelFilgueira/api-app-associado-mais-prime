import { AlloyalCatalogoService } from 'src/beneficios/services/alloyal-catalogo.service';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { RedisEmMemoria } from 'src/infra/redis/testing/redis-em-memoria';
import {
  AlloyalGateway,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';
import { IntegrationError } from 'src/shared/erros/erros';

describe('AlloyalCatalogoService — cache do catálogo', () => {
  const sessao: SessaoAlloyal = { uid: 'u1', client: 'c1', accessToken: 't1' };
  const outraSessao: SessaoAlloyal = {
    uid: 'u2',
    client: 'c2',
    accessToken: 't2',
  };
  const categorias = [
    { id: 1, title: 'Alimentação', icon: 'a.png', subcategories: [] },
    { id: 2, title: 'Automotivo', icon: 'b.png', subcategories: [] },
  ];
  const organizacao = { id: 10, name: 'Loja', distance_km: 1.234, extra: 'x' };
  const alloyalFora = () =>
    new IntegrationError({
      vendor: 'alloyal',
      tipo: 'indisponivel',
      base: 'MAIS_PRIME',
      statusVendor: 503,
    });

  let redis: RedisEmMemoria;
  let alloyal: Record<
    | 'listarCategorias'
    | 'listarOrganizacoesDaCategoria'
    | 'listarOrganizacoes'
    | 'listarOrganizacoesProximas'
    | 'listarDestaquesProximos'
    | 'listarDestaquesOnline'
    | 'listarFiliais'
    | 'listarPromocoes',
    jest.Mock
  >;
  let painel: AlloyalCategoriesCacheService;
  let catalogo: AlloyalCatalogoService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-25T12:00:00Z') });
    redis = new RedisEmMemoria();
    const cache = new CacheService(redis.comoRedis());
    alloyal = {
      listarCategorias: jest.fn().mockResolvedValue(categorias),
      listarOrganizacoesDaCategoria: jest.fn().mockResolvedValue([organizacao]),
      listarOrganizacoes: jest.fn().mockResolvedValue([organizacao]),
      listarOrganizacoesProximas: jest.fn().mockResolvedValue([organizacao]),
      listarDestaquesProximos: jest.fn().mockResolvedValue([organizacao]),
      listarDestaquesOnline: jest.fn().mockResolvedValue([organizacao]),
      listarFiliais: jest.fn().mockResolvedValue([{ id: 1 }]),
      listarPromocoes: jest.fn().mockResolvedValue([{ id: 1 }]),
    };
    painel = new AlloyalCategoriesCacheService(cache);
    catalogo = new AlloyalCatalogoService(
      alloyal as unknown as AlloyalGateway,
      cache,
      painel,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const chavesDoApp = () =>
    redis.chaves().filter((chave) => !chave.endsWith(':categorias_painel'));

  describe('categorias', () => {
    it('a segunda leitura não chama a Alloyal — nem a de outro usuário da mesma base', async () => {
      const primeira = await catalogo.categorias('MAIS_PRIME', sessao);
      const segunda = await catalogo.categorias('MAIS_PRIME', sessao);
      const deOutroUsuario = await catalogo.categorias(
        'MAIS_PRIME',
        outraSessao,
      );

      expect(primeira).toEqual(categorias);
      expect(segunda).toEqual(categorias);
      expect(deOutroUsuario).toEqual(categorias);
      expect(alloyal.listarCategorias).toHaveBeenCalledTimes(1);
      expect(alloyal.listarCategorias).toHaveBeenCalledWith(
        'MAIS_PRIME',
        sessao,
      );
      expect(chavesDoApp()).toEqual(['MAIS_PRIME:alloyal:catalogo:categorias']);
    });

    it('a base A não lê o cache da base B', async () => {
      const doRs = [{ id: 9, title: 'Só no RS' }];
      alloyal.listarCategorias
        .mockResolvedValueOnce(categorias)
        .mockResolvedValueOnce(doRs);

      await catalogo.categorias('MAIS_PRIME', sessao);
      const rs = await catalogo.categorias('MAIS_PRIME_RS', sessao);
      const mp = await catalogo.categorias('MAIS_PRIME', sessao);

      expect(rs).toEqual(doRs);
      expect(mp).toEqual(categorias);
      expect(alloyal.listarCategorias.mock.calls.map(([base]) => base)).toEqual(
        ['MAIS_PRIME', 'MAIS_PRIME_RS'],
      );
      expect(chavesDoApp().sort()).toEqual([
        'MAIS_PRIME:alloyal:catalogo:categorias',
        'MAIS_PRIME_RS:alloyal:catalogo:categorias',
      ]);
    });

    it('erro da Alloyal não é guardado: propaga, e a leitura seguinte consulta de novo', async () => {
      alloyal.listarCategorias.mockRejectedValueOnce(alloyalFora());

      await expect(
        catalogo.categorias('MAIS_PRIME', sessao),
      ).rejects.toMatchObject({ tipo: 'indisponivel', statusVendor: 503 });
      expect(redis.chaves()).toEqual([]);

      await expect(catalogo.categorias('MAIS_PRIME', sessao)).resolves.toEqual(
        categorias,
      );
      expect(alloyal.listarCategorias).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['lista vazia', []],
      ['corpo que não é lista', { erro: 'inesperado' }],
      ['corpo nulo', null],
    ])(
      '%s é devolvido como veio, mas não fica no cache',
      async (_caso, corpo) => {
        alloyal.listarCategorias.mockResolvedValue(corpo);

        await expect(
          catalogo.categorias('MAIS_PRIME', sessao),
        ).resolves.toEqual(corpo);
        await catalogo.categorias('MAIS_PRIME', sessao);

        expect(alloyal.listarCategorias).toHaveBeenCalledTimes(2);
        expect(redis.chaves()).toEqual([]);
      },
    );

    it('Redis fora não derruba a rota: lê direto da Alloyal, toda vez', async () => {
      redis.fora = true;

      await expect(catalogo.categorias('MAIS_PRIME', sessao)).resolves.toEqual(
        categorias,
      );
      await expect(catalogo.categorias('MAIS_PRIME', sessao)).resolves.toEqual(
        categorias,
      );

      expect(alloyal.listarCategorias).toHaveBeenCalledTimes(2);
    });

    it('Redis volta: o cache volta a valer', async () => {
      redis.fora = true;
      await catalogo.categorias('MAIS_PRIME', sessao);
      redis.fora = false;

      await catalogo.categorias('MAIS_PRIME', sessao);
      await catalogo.categorias('MAIS_PRIME', sessao);

      expect(alloyal.listarCategorias).toHaveBeenCalledTimes(2);
    });

    it('vale por 6 horas (com folga de 10%); depois consulta de novo', async () => {
      await catalogo.categorias('MAIS_PRIME', sessao);

      jest.advanceTimersByTime(5 * 3_600_000);
      await catalogo.categorias('MAIS_PRIME', sessao);
      expect(alloyal.listarCategorias).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(2 * 3_600_000);
      await catalogo.categorias('MAIS_PRIME', sessao);
      expect(alloyal.listarCategorias).toHaveBeenCalledTimes(2);
    });

    it('leituras simultâneas fazem UMA ida à Alloyal', async () => {
      const respostas = await Promise.all([
        catalogo.categorias('MAIS_PRIME', sessao),
        catalogo.categorias('MAIS_PRIME', outraSessao),
        catalogo.categorias('MAIS_PRIME', sessao),
      ]);

      expect(respostas).toEqual([categorias, categorias, categorias]);
      expect(alloyal.listarCategorias).toHaveBeenCalledTimes(1);
    });

    it('vencido e com a Alloyal fora → erro (não serve valor antigo)', async () => {
      await catalogo.categorias('MAIS_PRIME', sessao);
      jest.advanceTimersByTime(7 * 3_600_000);
      alloyal.listarCategorias.mockRejectedValueOnce(alloyalFora());

      await expect(
        catalogo.categorias('MAIS_PRIME', sessao),
      ).rejects.toBeInstanceOf(IntegrationError);
    });
  });

  describe('categorias para o painel (parceiros diretos)', () => {
    it('ao consultar a Alloyal, guarda id e título por base para o painel', async () => {
      await catalogo.categorias('MAIS_PRIME', sessao);

      await expect(
        painel.obterPorBase(['MAIS_PRIME', 'MAIS_PRIME_RS']),
      ).resolves.toEqual({
        MAIS_PRIME: [
          { id: 1, title: 'Alimentação' },
          { id: 2, title: 'Automotivo' },
        ],
        MAIS_PRIME_RS: [],
      });
    });

    it('o resumo do painel sobrevive ao vencimento do cache do app (7 dias)', async () => {
      await catalogo.categorias('MAIS_PRIME', sessao);

      jest.advanceTimersByTime(3 * 24 * 3_600_000);

      await expect(painel.obter('MAIS_PRIME')).resolves.toHaveLength(2);
      // O valor que o app lê já venceu (6 h): só o resumo do painel resta.
      await expect(
        redis.get('MAIS_PRIME:alloyal:catalogo:categorias'),
      ).resolves.toBeNull();
    });

    it('a leitura do painel nunca responde no lugar da Alloyal para o app', async () => {
      await expect(painel.obter('MAIS_PRIME')).resolves.toEqual([]);

      await expect(catalogo.categorias('MAIS_PRIME', sessao)).resolves.toEqual(
        categorias,
      );
      expect(alloyal.listarCategorias).toHaveBeenCalledTimes(1);
    });

    it('quando o cache do app vence, a nova leitura atualiza o resumo do painel', async () => {
      await catalogo.categorias('MAIS_PRIME', sessao);
      jest.advanceTimersByTime(7 * 3_600_000);
      alloyal.listarCategorias.mockResolvedValue([{ id: 3, title: 'Nova' }]);

      await catalogo.categorias('MAIS_PRIME', sessao);

      await expect(painel.obter('MAIS_PRIME')).resolves.toEqual([
        { id: 3, title: 'Nova' },
      ]);
    });
  });

  describe('destaques online', () => {
    it('mapeia (sem distância) e guarda: a segunda leitura não chama a Alloyal', async () => {
      const primeira = await catalogo.destaquesOnline('MAIS_PRIME', sessao);
      const segunda = await catalogo.destaquesOnline('MAIS_PRIME', outraSessao);

      expect(primeira).toEqual([{ id: 10, name: 'Loja' }]);
      expect(primeira[0]).not.toHaveProperty('distance_km');
      // O que volta do cache é o mesmo JSON que saiu da primeira vez.
      expect(JSON.stringify(segunda)).toBe(JSON.stringify(primeira));
      expect(alloyal.listarDestaquesOnline).toHaveBeenCalledTimes(1);
      expect(redis.chaves()).toEqual([
        'MAIS_PRIME:alloyal:catalogo:destaques_online',
      ]);
    });

    it('por base; erro e lista vazia não são guardados', async () => {
      alloyal.listarDestaquesOnline
        .mockRejectedValueOnce(alloyalFora())
        .mockResolvedValueOnce([])
        .mockResolvedValue([organizacao]);

      await expect(
        catalogo.destaquesOnline('MAIS_PRIME', sessao),
      ).rejects.toBeInstanceOf(IntegrationError);
      await expect(
        catalogo.destaquesOnline('MAIS_PRIME', sessao),
      ).resolves.toEqual([]);
      expect(redis.chaves()).toEqual([]);

      await catalogo.destaquesOnline('MAIS_PRIME', sessao);
      await catalogo.destaquesOnline('MAIS_PRIME_RS', sessao);
      expect(alloyal.listarDestaquesOnline).toHaveBeenCalledTimes(4);
      expect(redis.chaves().sort()).toEqual([
        'MAIS_PRIME:alloyal:catalogo:destaques_online',
        'MAIS_PRIME_RS:alloyal:catalogo:destaques_online',
      ]);
    });
  });

  describe('organizações', () => {
    it('sem coordenada nem busca: guarda por tipo e página', async () => {
      await catalogo.organizacoes('MAIS_PRIME', sessao, {});
      await catalogo.organizacoes('MAIS_PRIME', outraSessao, { page: '1' });
      expect(alloyal.listarOrganizacoes).toHaveBeenCalledTimes(1);

      await catalogo.organizacoes('MAIS_PRIME', sessao, { page: '2' });
      await catalogo.organizacoes('MAIS_PRIME', sessao, {
        organization_type: 'online',
      });
      expect(alloyal.listarOrganizacoes).toHaveBeenCalledTimes(3);
      expect(redis.chaves().sort()).toEqual([
        'MAIS_PRIME:alloyal:catalogo:organizacoes:online:p1',
        'MAIS_PRIME:alloyal:catalogo:organizacoes:todos:p1',
        'MAIS_PRIME:alloyal:catalogo:organizacoes:todos:p2',
      ]);
    });

    it('o valor guardado é o já mapeado (sem campo do usuário), com distância 0', async () => {
      alloyal.listarOrganizacoes.mockResolvedValue([
        { id: 10, name: 'Loja', favorited: true },
      ]);

      await catalogo.organizacoes('MAIS_PRIME', sessao, {});
      const doCache = await catalogo.organizacoes(
        'MAIS_PRIME',
        outraSessao,
        {},
      );

      expect(doCache).toEqual([{ id: 10, name: 'Loja', distance_km: 0 }]);
      expect(redis.chaves()).toHaveLength(1);
      const guardado = await redis.get(redis.chaves()[0]);
      expect(guardado).not.toContain('favorited');
    });

    it.each([
      ['coordenadas', { lat: '-22.9', lng: '-43.1' }],
      ['só latitude', { lat: '-22.9' }],
      ['busca', { search: 'pizza' }],
      [
        'busca com coordenadas (o que o app envia hoje)',
        {
          search: 'pizza',
          lat: '-22.9',
          lng: '-43.1',
        },
      ],
      ['categoria', { category_id: '5' }],
      ['tipo desconhecido', { organization_type: 'qualquer' }],
    ])('com %s: nunca usa cache', async (_caso, filtros) => {
      await catalogo.organizacoes('MAIS_PRIME', sessao, filtros);
      await catalogo.organizacoes('MAIS_PRIME', sessao, filtros);

      expect(alloyal.listarOrganizacoes).toHaveBeenCalledTimes(2);
      expect(redis.chaves()).toEqual([]);
    });

    it('consulta com coordenada não lê o que a consulta sem coordenada guardou', async () => {
      await catalogo.organizacoes('MAIS_PRIME', sessao, {});
      alloyal.listarOrganizacoes.mockResolvedValue([
        { id: 10, name: 'Loja', distance_km: 2.5 },
      ]);

      const comCoordenada = await catalogo.organizacoes('MAIS_PRIME', sessao, {
        lat: '-22.9',
        lng: '-43.1',
      });

      expect(comCoordenada[0].distance_km).toBe(2.5);
      expect(alloyal.listarOrganizacoes).toHaveBeenLastCalledWith(
        'MAIS_PRIME',
        sessao,
        { page: 1, lat: '-22.9', lng: '-43.1' },
      );
    });
  });

  describe('o que depende do usuário ou da posição nunca entra no cache', () => {
    it('organizações da categoria (favorited), próximas, destaques próximos, filiais e promoções', async () => {
      for (let i = 0; i < 2; i++) {
        await catalogo.organizacoesDaCategoria('MAIS_PRIME', sessao, '7', {});
        await catalogo.organizacoesProximas('MAIS_PRIME', sessao, {});
        await catalogo.destaquesProximos('MAIS_PRIME', sessao, {});
        await catalogo.filiais('MAIS_PRIME', sessao, '9', {});
        await catalogo.promocoes('MAIS_PRIME', sessao, {});
      }

      expect(alloyal.listarOrganizacoesDaCategoria).toHaveBeenCalledTimes(2);
      expect(alloyal.listarOrganizacoesProximas).toHaveBeenCalledTimes(2);
      expect(alloyal.listarDestaquesProximos).toHaveBeenCalledTimes(2);
      expect(alloyal.listarFiliais).toHaveBeenCalledTimes(2);
      expect(alloyal.listarPromocoes).toHaveBeenCalledTimes(2);
      expect(redis.chaves()).toEqual([]);
    });

    it('cada chamada usa a sessão de quem pediu', async () => {
      await catalogo.organizacoesDaCategoria('MAIS_PRIME', sessao, '7', {});
      await catalogo.organizacoesDaCategoria('MAIS_PRIME', outraSessao, '7', {
        page: '2',
        lat: '-22.9',
        lng: '-43.1',
      });

      expect(alloyal.listarOrganizacoesDaCategoria.mock.calls).toEqual([
        ['MAIS_PRIME', sessao, '7', { page: 1 }],
        [
          'MAIS_PRIME',
          outraSessao,
          '7',
          { page: 2, lat: '-22.9', lng: '-43.1' },
        ],
      ]);
    });
  });
});

import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { RedisEmMemoria } from 'src/infra/redis/testing/redis-em-memoria';

/** Redis em memória cujas leituras podem ser seguradas por um portão. */
class RedisComPortao extends RedisEmMemoria {
  private portao: Promise<void> | null = null;
  private abrir: (() => void) | null = null;

  segurarLeituras(): void {
    this.portao = new Promise((resolver) => (this.abrir = resolver));
  }

  liberarLeituras(): void {
    this.abrir?.();
    this.portao = null;
  }

  override async get(chave: string): Promise<string | null> {
    if (this.portao) await this.portao;
    return super.get(chave);
  }
}

describe('AlloyalCategoriesCacheService (categorias da Alloyal para o painel)', () => {
  const CHAVE = 'MAIS_PRIME:alloyal:catalogo:categorias_painel';
  const categorias = [
    { id: 12, title: 'Automotivo', icon: 'x.png', subcategories: [{ id: 1 }] },
    { id: 13, title: 'Saúde' },
  ];
  const resumo = [
    { id: 12, title: 'Automotivo' },
    { id: 13, title: 'Saúde' },
  ];

  let redis: RedisComPortao;
  let servico: AlloyalCategoriesCacheService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-25T12:00:00Z') });
    redis = new RedisComPortao();
    servico = new AlloyalCategoriesCacheService(
      new CacheService(redis.comoRedis()),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('guarda só id e título, por base, na chave do catálogo', async () => {
    await servico.armazenar('MAIS_PRIME', categorias);

    await expect(servico.obter('MAIS_PRIME')).resolves.toEqual(resumo);
    await expect(servico.obter('MAIS_PRIME_RS')).resolves.toEqual([]);
    expect(redis.chaves()).toEqual([CHAVE]);
    expect(await redis.get(CHAVE)).not.toContain('icon');
  });

  it('obterPorBase: uma entrada por base; base sem cache devolve []', async () => {
    await servico.armazenar('MAIS_PRIME', categorias);

    await expect(
      servico.obterPorBase(['MAIS_PRIME', 'MAIS_PRIME_RS']),
    ).resolves.toEqual({ MAIS_PRIME: resumo, MAIS_PRIME_RS: [] });
    await expect(servico.obterPorBase([])).resolves.toEqual({});
  });

  it('ler não grava nada (base sem cache continua sem chave)', async () => {
    await servico.obter('MAIS_PRIME');
    await servico.obter('MAIS_PRIME');

    expect(redis.chaves()).toEqual([]);
  });

  it('uma nova gravação substitui a anterior', async () => {
    await servico.armazenar('MAIS_PRIME', categorias);
    await servico.armazenar('MAIS_PRIME', [{ id: 99, title: 'Nova' }]);

    await expect(servico.obter('MAIS_PRIME')).resolves.toEqual([
      { id: 99, title: 'Nova' },
    ]);
  });

  it.each([
    ['sem base', undefined, categorias],
    ['lista vazia', 'MAIS_PRIME', []],
    ['corpo que não é lista', 'MAIS_PRIME', { erro: 'x' }],
    ['lista sem nenhuma categoria válida', 'MAIS_PRIME', [{ title: 'sem id' }]],
  ])('%s: não grava e mantém o que havia', async (_caso, base, corpo) => {
    await servico.armazenar('MAIS_PRIME', categorias);

    await servico.armazenar(base, corpo);

    await expect(servico.obter('MAIS_PRIME')).resolves.toEqual(resumo);
  });

  it('vale por 7 dias (com folga de 10%)', async () => {
    await servico.armazenar('MAIS_PRIME', categorias);

    jest.advanceTimersByTime(6 * 24 * 3_600_000);
    await expect(servico.obter('MAIS_PRIME')).resolves.toEqual(resumo);

    jest.advanceTimersByTime(2 * 24 * 3_600_000);
    await expect(servico.obter('MAIS_PRIME')).resolves.toEqual([]);
  });

  it('Redis fora: gravar não lança e ler devolve []', async () => {
    redis.fora = true;

    await expect(
      servico.armazenar('MAIS_PRIME', categorias),
    ).resolves.toBeUndefined();
    await expect(servico.obter('MAIS_PRIME')).resolves.toEqual([]);
    await expect(servico.obterPorBase(['MAIS_PRIME'])).resolves.toEqual({
      MAIS_PRIME: [],
    });
  });

  it('gravação que cai no meio de uma leitura do painel não se perde', async () => {
    // O painel começa a ler (e fica esperando o Redis)...
    redis.segurarLeituras();
    const leituraDoPainel = servico.obter('MAIS_PRIME');
    // ...o app carrega as categorias nesse instante...
    const gravacao = servico.armazenar('MAIS_PRIME', categorias);
    redis.liberarLeituras();

    await expect(leituraDoPainel).resolves.toEqual([]);
    await gravacao;

    // ...e o resumo ficou gravado para a próxima leitura.
    await expect(servico.obter('MAIS_PRIME')).resolves.toEqual(resumo);
  });
});

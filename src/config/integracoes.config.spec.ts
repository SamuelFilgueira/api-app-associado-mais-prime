import {
  ALLOYAL_TIMEOUT_MS,
  alloyalConfig,
  prazosDoCacheAlloyal,
} from 'src/config/integracoes.config';

describe('alloyalConfig', () => {
  it('tira a barra final da URL da API e deriva a origem das rotas administrativas', () => {
    expect(
      alloyalConfig({
        BASE_URL_ALLOYAL: ' https://api.alloyal.teste/api/v1// ',
        x_clientemployee_email: 'employee@teste.local',
        x_clientemployee_token: 'token',
      }),
    ).toEqual({
      urlDaApi: 'https://api.alloyal.teste/api/v1',
      origemAdministrativa: 'https://api.alloyal.teste',
      employeeEmail: 'employee@teste.local',
      employeeToken: 'token',
      timeoutMs: ALLOYAL_TIMEOUT_MS,
    });
  });

  it('sem BASE_URL_ALLOYAL: API não configurada, rotas administrativas na origem padrão', () => {
    expect(alloyalConfig({})).toEqual({
      urlDaApi: undefined,
      origemAdministrativa: 'https://api.lecupon.com',
      employeeEmail: undefined,
      employeeToken: undefined,
      timeoutMs: 20_000,
    });
    expect(alloyalConfig({ BASE_URL_ALLOYAL: '   ' }).urlDaApi).toBeUndefined();
  });

  it('URL que não é URL: sem origem administrativa (o client recusa a chamada)', () => {
    expect(
      alloyalConfig({ BASE_URL_ALLOYAL: 'api.alloyal.teste/v1' })
        .origemAdministrativa,
    ).toBeUndefined();
  });

  it('credencial de employee vazia conta como ausente', () => {
    const config = alloyalConfig({
      x_clientemployee_email: '',
      x_clientemployee_token: '',
    });

    expect(config.employeeEmail).toBeUndefined();
    expect(config.employeeToken).toBeUndefined();
  });

  it('lê o ambiente do processo a cada chamada', () => {
    const original = process.env.BASE_URL_ALLOYAL;
    try {
      process.env.BASE_URL_ALLOYAL = 'https://um.teste/';
      expect(alloyalConfig().urlDaApi).toBe('https://um.teste');
      process.env.BASE_URL_ALLOYAL = 'https://outro.teste/';
      expect(alloyalConfig().urlDaApi).toBe('https://outro.teste');
    } finally {
      if (original === undefined) delete process.env.BASE_URL_ALLOYAL;
      else process.env.BASE_URL_ALLOYAL = original;
    }
  });
});

describe('prazosDoCacheAlloyal', () => {
  it('padrões: 6 h, 3 h e 1 h', () => {
    expect(prazosDoCacheAlloyal({})).toEqual({
      categoriasSeg: 6 * 3600,
      destaquesOnlineSeg: 3 * 3600,
      organizacoesSeg: 3600,
    });
  });

  it('0 desliga o cache do recurso, sem deploy', () => {
    expect(
      prazosDoCacheAlloyal({
        ALLOYAL_CACHE_CATEGORIAS_SEG: '0',
        ALLOYAL_CACHE_DESTAQUES_SEG: '0',
        ALLOYAL_CACHE_ORGANIZACOES_SEG: '0',
      }),
    ).toEqual({ categoriasSeg: 0, destaquesOnlineSeg: 0, organizacoesSeg: 0 });
  });

  it('valor inválido ou vazio cai no padrão; acima de 24 h é limitado', () => {
    expect(
      prazosDoCacheAlloyal({
        ALLOYAL_CACHE_CATEGORIAS_SEG: 'abc',
        ALLOYAL_CACHE_DESTAQUES_SEG: ' ',
        ALLOYAL_CACHE_ORGANIZACOES_SEG: '9999999',
      }),
    ).toEqual({
      categoriasSeg: 6 * 3600,
      destaquesOnlineSeg: 3 * 3600,
      organizacoesSeg: 86_400,
    });
    expect(
      prazosDoCacheAlloyal({ ALLOYAL_CACHE_CATEGORIAS_SEG: '-5' })
        .categoriasSeg,
    ).toBe(0);
  });
});

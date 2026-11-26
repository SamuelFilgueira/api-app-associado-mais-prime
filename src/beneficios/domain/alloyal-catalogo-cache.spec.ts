import {
  CHAVE_CATEGORIAS,
  CHAVE_CATEGORIAS_DO_PAINEL,
  CHAVE_DESTAQUES_ONLINE,
  PAGINA_MAXIMA,
  PRAZO_CATEGORIAS_DO_PAINEL_SEG,
  chaveDeOrganizacoes,
  listaComItens,
  resumirCategorias,
} from 'src/beneficios/domain/alloyal-catalogo-cache';
import { paramsDeOrganizacoes } from 'src/beneficios/domain/alloyal-consultas';

describe('domínio Alloyal — o que do catálogo entra no cache', () => {
  it('chaves no formato alloyal:catalogo:<recurso> (a base é prefixada pelo CacheService)', () => {
    for (const chave of [
      CHAVE_CATEGORIAS,
      CHAVE_DESTAQUES_ONLINE,
      CHAVE_CATEGORIAS_DO_PAINEL,
      chaveDeOrganizacoes({ page: 1 }),
    ]) {
      expect(chave).toMatch(/^alloyal:catalogo:[a-z_]+(:[a-z0-9_]+)*$/);
    }
    // O painel lê uma chave própria, nunca a que responde ao app.
    expect(CHAVE_CATEGORIAS_DO_PAINEL).not.toBe(CHAVE_CATEGORIAS);
  });

  it('o resumo das categorias para o painel fica guardado por 7 dias', () => {
    expect(PRAZO_CATEGORIAS_DO_PAINEL_SEG).toBe(7 * 24 * 3600);
  });

  describe('chaveDeOrganizacoes', () => {
    it('só página (e tipo conhecido) → chave com o tipo e a página', () => {
      expect(chaveDeOrganizacoes({ page: 1 })).toBe(
        'alloyal:catalogo:organizacoes:todos:p1',
      );
      expect(
        chaveDeOrganizacoes({ page: 3, organization_type: 'online' }),
      ).toBe('alloyal:catalogo:organizacoes:online:p3');
      expect(
        chaveDeOrganizacoes({ page: 2, organization_type: 'física' }),
      ).toBe('alloyal:catalogo:organizacoes:fisica:p2');
    });

    it.each([
      ['coordenada (lat)', { page: 1, lat: '-22.9' }],
      ['coordenada (lng)', { page: 1, lng: '-43.1' }],
      ['coordenada arredondada', { page: 1, lat: '-22.9', lng: '-43.1' }],
      ['busca (texto livre)', { page: 1, search: 'pizza' }],
      ['categoria (id arbitrário)', { page: 1, category_id: 5 }],
      ['parâmetro desconhecido', { page: 1, cpf: '12345678900' }],
      ['tipo fora do conjunto', { page: 1, organization_type: 'qualquer' }],
      [
        'tipo com nome de propriedade',
        { page: 1, organization_type: 'toString' },
      ],
      ['página zero', { page: 0 }],
      ['página negativa', { page: -1 }],
      ['página fracionária', { page: 1.5 }],
      ['página NaN', { page: NaN }],
      ['página como texto', { page: '1' }],
      ['página além do teto', { page: PAGINA_MAXIMA + 1 }],
      ['sem página', {}],
    ])('%s → não entra no cache', (_caso, params) => {
      expect(chaveDeOrganizacoes(params)).toBeNull();
    });

    it('o número de chaves possíveis por base é fechado (tipos × páginas)', () => {
      const chaves = new Set<string>();
      for (const tipo of [undefined, 'online', 'física', 'x', 'y', 'z']) {
        for (let pagina = -5; pagina <= PAGINA_MAXIMA + 50; pagina++) {
          const chave = chaveDeOrganizacoes({
            page: pagina,
            ...(tipo ? { organization_type: tipo } : {}),
          });
          if (chave) chaves.add(chave);
        }
      }
      expect(chaves.size).toBe(3 * PAGINA_MAXIMA);
    });

    it('decide pelos parâmetros que VÃO para a Alloyal: mesma consulta, mesma chave', () => {
      const chave = (filtros: Parameters<typeof paramsDeOrganizacoes>[0]) =>
        chaveDeOrganizacoes(paramsDeOrganizacoes(filtros));

      // Sem página e com página 1 são a mesma consulta.
      expect(chave({})).toBe(chave({ page: '1' }));
      // Filtro vazio não é enviado: não muda a chave nem impede o cache.
      expect(chave({ search: '', lat: '', category_id: '0' })).toBe(chave({}));
      // Com coordenada ou busca de verdade, não há chave.
      expect(chave({ lat: '-22.9', lng: '-43.1' })).toBeNull();
      expect(chave({ search: 'pizza' })).toBeNull();
    });
  });

  it('listaComItens: só lista com pelo menos um item vale guardar', () => {
    expect(listaComItens([{ id: 1 }])).toBe(true);
    expect(listaComItens([])).toBe(false);
    expect(listaComItens({ id: 1 })).toBe(false);
    expect(listaComItens(null)).toBe(false);
    expect(listaComItens('<html>')).toBe(false);
    expect(listaComItens(undefined)).toBe(false);
  });

  describe('resumirCategorias', () => {
    it('fica com id e título das categorias com id inteiro', () => {
      expect(
        resumirCategorias([
          { id: 12, title: 'Automotivo', icon: 'x', subcategories: [] },
          { id: 13 },
          { id: '14', title: 'id como texto: fora' },
          { title: 'sem id: fora' },
          null,
          'texto',
        ]),
      ).toEqual([
        { id: 12, title: 'Automotivo' },
        { id: 13, title: '' },
      ]);
    });

    it('o que não é lista → vazio', () => {
      expect(resumirCategorias({ categories: [] })).toEqual([]);
      expect(resumirCategorias(null)).toEqual([]);
      expect(resumirCategorias('<html>')).toEqual([]);
    });
  });
});

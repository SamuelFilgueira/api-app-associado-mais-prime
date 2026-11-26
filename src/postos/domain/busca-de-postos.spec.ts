import {
  POSTOS_POR_PAGINA,
  TTL_DO_CACHE_DE_POSTOS_SEG,
  chaveDoCacheDePostos,
  descreverPosto,
  paginarPostos,
} from 'src/postos/domain/busca-de-postos';

describe('busca de postos (regra pura)', () => {
  describe('chaveDoCacheDePostos', () => {
    const busca = { latitude: -22.9068, longitude: -43.1729, placa: 'ABC1D23' };

    it('começa por `postos:` e leva a placa e as coordenadas normalizadas', () => {
      expect(chaveDoCacheDePostos(busca)).toBe(
        'postos:ABC1D23:-22.907:-43.173',
      );
    });

    it('leituras de GPS do mesmo lugar (poucos metros de diferença) dão a mesma chave', () => {
      expect(
        chaveDoCacheDePostos({
          ...busca,
          latitude: -22.90684,
          longitude: -43.17293,
        }),
      ).toBe(chaveDoCacheDePostos(busca));
    });

    it('placa com máscara ou em minúsculas é a mesma busca', () => {
      expect(chaveDoCacheDePostos({ ...busca, placa: 'abc-1d23' })).toBe(
        chaveDoCacheDePostos(busca),
      );
    });

    it.each([
      ['outra placa', { placa: 'XYZ9A88' }],
      ['latitude a ~200 m', { latitude: -22.9088 }],
      ['longitude a ~200 m', { longitude: -43.1749 }],
    ])('%s: outra chave', (_caso, mudanca) => {
      expect(chaveDoCacheDePostos({ ...busca, ...mudanca })).not.toBe(
        chaveDoCacheDePostos(busca),
      );
    });

    it('zero negativo e zero positivo são a mesma coordenada', () => {
      expect(
        chaveDoCacheDePostos({
          ...busca,
          latitude: -0.0001,
          longitude: 0.0001,
        }),
      ).toBe('postos:ABC1D23:0.000:0.000');
    });
  });

  it('o cache vale entre 15 e 60 minutos', () => {
    expect(TTL_DO_CACHE_DE_POSTOS_SEG).toBeGreaterThanOrEqual(15 * 60);
    expect(TTL_DO_CACHE_DE_POSTOS_SEG).toBeLessThanOrEqual(60 * 60);
  });

  describe('paginarPostos', () => {
    const postos = Array.from({ length: 12 }, (_, i) => i + 1);

    it('5 por página', () => {
      expect(POSTOS_POR_PAGINA).toBe(5);
      expect(paginarPostos(postos, 1)).toEqual({
        pagination: {
          totalElements: 12,
          pageSize: 5,
          pageNumber: 1,
          totalPages: 3,
        },
        result: [1, 2, 3, 4, 5],
        inicio: 0,
        fim: 5,
      });
    });

    it('última página traz o resto; além do fim, vazio', () => {
      expect(paginarPostos(postos, 3).result).toEqual([11, 12]);
      expect(paginarPostos(postos, 4).result).toEqual([]);
      expect(paginarPostos(postos, 4).pagination.totalPages).toBe(3);
    });

    it('lista vazia: zero páginas', () => {
      expect(paginarPostos([], 1).pagination).toEqual({
        totalElements: 0,
        pageSize: 5,
        pageNumber: 1,
        totalPages: 0,
      });
    });
  });

  it('descreverPosto marca os postos da página atual e tolera campos ausentes', () => {
    expect(
      descreverPosto(
        {
          id: 7,
          postoNome: 'Posto A',
          enderecoPosto: 'Rua 1',
          distancia: 1.2,
          latitude: -22.9,
          longitude: -43.2,
        },
        5,
        5,
        true,
      ),
    ).toBe(
      '>> #6 pág.2 | Posto A | Rua 1 | 1.2 km | lat=-22.9 lng=-43.2 | id=7',
    );
    expect(descreverPosto(null, 0, 5, false)).toBe(
      '   #1 pág.1 | (sem nome) | (sem endereço) | ? km | lat=? lng=? | id=?',
    );
  });
});

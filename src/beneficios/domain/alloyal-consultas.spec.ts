import {
  cupomDoResgate,
  idNumerico,
  paginaOuPrimeira,
  paramsDeCoordenadas,
  paramsDeCuponsDaFilial,
  paramsDeCuponsDaOrganizacao,
  paramsDeOrganizacoes,
  paramsDeOrganizacoesDaCategoria,
  paramsDePromocoes,
} from 'src/beneficios/domain/alloyal-consultas';

describe('domínio Alloyal — filtros das consultas', () => {
  it('paginaOuPrimeira: sem página (ou vazia) é a primeira', () => {
    expect(paginaOuPrimeira(undefined)).toBe(1);
    expect(paginaOuPrimeira('')).toBe(1);
    expect(paginaOuPrimeira('3')).toBe(3);
    // Comportamento vigente: texto não numérico segue como NaN para a Alloyal.
    expect(paginaOuPrimeira('abc')).toBeNaN();
  });

  it('idNumerico converte o id do caminho', () => {
    expect(idNumerico('5')).toBe(5);
    expect(idNumerico('abc')).toBeNaN();
  });

  it('coordenadas: só as informadas, como texto', () => {
    expect(paramsDeCoordenadas({ lat: '-22.9', lng: '-43.1' })).toEqual({
      lat: '-22.9',
      lng: '-43.1',
    });
    expect(paramsDeCoordenadas({ lat: '-22.9' })).toEqual({ lat: '-22.9' });
    expect(paramsDeCoordenadas({ lat: '', lng: undefined })).toEqual({});
    expect(paramsDeCoordenadas({ lat: '0', lng: '0' })).toEqual({
      lat: '0',
      lng: '0',
    });
  });

  it('organizações da categoria: página sempre, coordenadas se houver', () => {
    expect(paramsDeOrganizacoesDaCategoria({})).toEqual({ page: 1 });
    expect(
      paramsDeOrganizacoesDaCategoria({
        page: '2',
        lat: '-22.9',
        lng: '-43.1',
      }),
    ).toEqual({ page: 2, lat: '-22.9', lng: '-43.1' });
  });

  describe('organizações', () => {
    it('sem filtros → só a primeira página', () => {
      expect(paramsDeOrganizacoes({})).toEqual({ page: 1 });
    });

    it('todos os filtros, na ordem de sempre, com página e categoria numéricas', () => {
      const params = paramsDeOrganizacoes({
        category_id: '5',
        search: 'pizza',
        organization_type: 'online',
        lng: '-43.1',
        lat: '-22.9',
        page: '3',
      });

      expect(params).toEqual({
        page: 3,
        lat: '-22.9',
        lng: '-43.1',
        organization_type: 'online',
        search: 'pizza',
        category_id: 5,
      });
      expect(Object.keys(params)).toEqual([
        'page',
        'lat',
        'lng',
        'organization_type',
        'search',
        'category_id',
      ]);
    });

    it.each(['', '0', 'abc'])('categoria %p não é enviada', (category_id) => {
      expect(paramsDeOrganizacoes({ category_id })).toEqual({ page: 1 });
    });

    it('tipo e busca vazios não são enviados', () => {
      expect(
        paramsDeOrganizacoes({ organization_type: '', search: '' }),
      ).toEqual({ page: 1 });
    });
  });

  describe('promoções', () => {
    it('sem filtros → nenhum parâmetro', () => {
      expect(paramsDePromocoes({})).toEqual({});
    });

    it('todos os filtros, na ordem de sempre', () => {
      const params = paramsDePromocoes({
        term: 'pizza',
        distance_km: '12',
        organization_id: '3',
        category_id: '5',
        redeem_type: 'online',
        page: '2',
        lng: '-43.1',
        lat: '-22.9',
      });

      expect(params).toEqual({
        lat: '-22.9',
        lng: '-43.1',
        page: 2,
        redeem_type: 'online',
        category_id: 5,
        organization_id: 3,
        distance_km: 12,
        term: 'pizza',
      });
      expect(Object.keys(params)).toEqual([
        'lat',
        'lng',
        'page',
        'redeem_type',
        'category_id',
        'organization_id',
        'distance_km',
        'term',
      ]);
    });

    it.each([
      ['30', 30],
      ['31', 30],
      ['80', 30],
      ['29.5', 29.5],
      ['1', 1],
    ])('distância %s km → %s (teto de 30)', (pedida, enviada) => {
      expect(paramsDePromocoes({ distance_km: pedida })).toEqual({
        distance_km: enviada,
      });
    });

    it.each(['0', '', 'abc'])(
      'números %p (página, categoria, organização, distância) não são enviados',
      (valor) => {
        expect(
          paramsDePromocoes({
            page: valor,
            category_id: valor,
            organization_id: valor,
            distance_km: valor,
          }),
        ).toEqual({});
      },
    );
  });

  it('cupons da organização: online quando o tipo de uso não vem', () => {
    expect(paramsDeCuponsDaOrganizacao(undefined)).toEqual({
      usage_type: 'online',
    });
    expect(paramsDeCuponsDaOrganizacao('presencial')).toEqual({
      usage_type: 'presencial',
    });
    // Comportamento vigente: `?usage_type=` (vazio) segue vazio.
    expect(paramsDeCuponsDaOrganizacao('')).toEqual({ usage_type: '' });
  });

  it('cupons da filial: página informada ou a primeira', () => {
    expect(paramsDeCuponsDaFilial(undefined)).toEqual({ page: 1 });
    expect(paramsDeCuponsDaFilial('4')).toEqual({ page: 4 });
  });

  it('cupomDoResgate: id numérico do cupom', () => {
    expect(cupomDoResgate('6')).toEqual({ coupon_id: 6 });
  });
});

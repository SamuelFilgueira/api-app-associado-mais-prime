import {
  arredondarDistancia,
  mapearFilial,
  mapearOrganizacao,
  mapearOrganizacaoDaCategoria,
  mapearOrganizacaoSemDistancia,
  mapearPromocao,
} from 'src/beneficios/domain/alloyal-catalogo';
import {
  dataHoraLocal,
  dataLocal,
  horaMinutoLocal,
} from 'src/beneficios/domain/alloyal-datas';

const SP = 'America/Sao_Paulo';

describe('domínio Alloyal — catálogo', () => {
  describe('datas', () => {
    it('formata no fuso informado', () => {
      const instante = '2026-11-25T15:30:00.000Z';

      expect(dataHoraLocal(instante, SP)).toBe('25/11/2026, 12:30:00');
      expect(dataHoraLocal(instante, 'UTC')).toBe('25/11/2026, 15:30:00');
      expect(dataLocal('2026-12-25T02:00:00.000Z', SP)).toBe('24/12/2026');
      expect(dataLocal('2026-12-25T02:00:00.000Z', 'UTC')).toBe('25/12/2026');
      expect(horaMinutoLocal('2000-01-01T12:05:00.000Z', SP)).toBe('10:05');
    });

    it.each([null, undefined, '', 0])('sem data (%p) → vazio', (valor) => {
      expect(dataHoraLocal(valor, SP)).toBe('');
      expect(dataLocal(valor, SP)).toBe('');
      expect(horaMinutoLocal(valor, SP)).toBe('');
    });

    it('sem fuso usa o do processo (o mesmo resultado de passar o fuso do processo)', () => {
      const doProcesso = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const instante = '2026-11-25T15:30:00.000Z';

      expect(dataHoraLocal(instante)).toBe(dataHoraLocal(instante, doProcesso));
      expect(dataLocal(instante)).toBe(dataLocal(instante, doProcesso));
      expect(horaMinutoLocal(instante)).toBe(
        horaMinutoLocal(instante, doProcesso),
      );
    });
  });

  describe('arredondarDistancia', () => {
    it.each([
      [1.23456, 1.23],
      [1.235, 1.24],
      [0.004, 0],
      ['2.5', 2.5],
      [12, 12],
      [0, 0],
      [null, 0],
      [undefined, 0],
      ['', 0],
    ])('%p → %p', (entrada, saida) => {
      expect(arredondarDistancia(entrada)).toBe(saida);
    });
  });

  const bruta = {
    extra_antes: 'não sai',
    id: 10,
    name: 'Loja',
    cover_picture: 'capa.png',
    background_picture: 'fundo.png',
    best_discount_percent: 15,
    category_name: 'Alimentação',
    instagram_url: 'insta',
    facebook_url: 'face',
    twitter_url: 'tw',
    cashback_percent: null,
    cashback_text: null,
    discount_text: '15% off',
    description: 'Descrição',
    distance_km: 1.23456,
    favorited: true,
  };

  describe('organização das listagens', () => {
    it('devolve só os 13 campos, na ordem de sempre, mais a distância', () => {
      const mapeada = mapearOrganizacao(bruta);

      expect(Object.keys(mapeada)).toEqual([
        'id',
        'name',
        'cover_picture',
        'background_picture',
        'best_discount_percent',
        'category_name',
        'instagram_url',
        'facebook_url',
        'twitter_url',
        'cashback_percent',
        'cashback_text',
        'discount_text',
        'description',
        'distance_km',
      ]);
      expect(mapeada).toMatchObject({
        id: 10,
        cashback_percent: null,
        distance_km: 1.23,
      });
      expect(mapeada).not.toHaveProperty('favorited');
    });

    it('sem distância informada → 0', () => {
      expect(mapearOrganizacao({ id: 1 }).distance_km).toBe(0);
    });

    it('destaque online não tem o campo de distância', () => {
      const mapeada = mapearOrganizacaoSemDistancia(bruta);

      expect(Object.keys(mapeada)).toHaveLength(13);
      expect(mapeada).not.toHaveProperty('distance_km');
      expect(mapeada).toMatchObject({ id: 10, name: 'Loja' });
    });

    it('o JSON que sai é o de sempre (campo ausente não aparece)', () => {
      expect(JSON.stringify(mapearOrganizacao({ id: 1, name: 'A' }))).toBe(
        '{"id":1,"name":"A","distance_km":0}',
      );
    });

    it('não altera o item recebido', () => {
      const copia = { ...bruta };
      mapearOrganizacao(bruta);
      mapearOrganizacaoDaCategoria(bruta);
      expect(bruta).toEqual(copia);
    });
  });

  describe('organização da categoria', () => {
    it('mantém tudo (inclusive favorited), menos redes sociais e imagens grandes', () => {
      const mapeada = mapearOrganizacaoDaCategoria({
        ...bruta,
        logo_image_small: 'p.png',
        top_background_image_large: 'x',
        top_background_image_v2_large: 'x',
        banner_image_large: 'x',
        banner_image_v2_large: 'x',
      });

      expect(mapeada).toMatchObject({
        id: 10,
        favorited: true,
        logo_image_small: 'p.png',
        extra_antes: 'não sai',
        distance_km: 1.23,
      });
      for (const removido of [
        'instagram_url',
        'facebook_url',
        'twitter_url',
        'top_background_image_large',
        'top_background_image_v2_large',
        'banner_image_large',
        'banner_image_v2_large',
      ]) {
        expect(mapeada).not.toHaveProperty(removido);
      }
    });

    it('sem distância → acrescenta distance_km 0 no fim', () => {
      expect(JSON.stringify(mapearOrganizacaoDaCategoria({ id: 2 }))).toBe(
        '{"id":2,"distance_km":0}',
      );
    });
  });

  describe('filial', () => {
    it('horários em HH:mm, distância arredondada, campos fixos', () => {
      expect(
        mapearFilial(
          {
            id: 1,
            name: 'Centro',
            taxpayer_number: '11222333000144',
            telephone: '2133334444',
            full_address: 'Rua A, 1',
            zipcode: '20000000',
            lat: -22.9,
            lng: -43.1,
            opening_time: '2000-01-01T12:00:00.000Z',
            closing_time: '2000-01-01T21:30:00.000Z',
            distance_km: 0.456,
            extra: 'não sai',
          },
          SP,
        ),
      ).toEqual({
        id: 1,
        name: 'Centro',
        taxpayer_number: '11222333000144',
        telephone: '2133334444',
        full_address: 'Rua A, 1',
        zipcode: '20000000',
        lat: -22.9,
        lng: -43.1,
        opening_time: '10:00',
        closing_time: '19:30',
        distance_km: 0.46,
      });
    });

    it('sem horário e sem distância → vazios e 0', () => {
      expect(mapearFilial({ id: 2 }, SP)).toMatchObject({
        opening_time: '',
        closing_time: '',
        distance_km: 0,
      });
    });
  });

  describe('promoção', () => {
    it('datas com hora, dias de funcionamento filtrados e tags', () => {
      expect(
        mapearPromocao(
          {
            id: 1,
            title: 'Promo',
            rules: 'regras',
            description: 'desc',
            url: null,
            discount: 10,
            start_date: '2026-11-25T15:30:00.000Z',
            end_date: '2026-12-25T02:00:00.000Z',
            working_days: [
              {
                week_day: 1,
                is_available: true,
                start_hour: '08:00',
                end_hour: '18:00',
                extra: 'não sai',
              },
            ],
            quantity: 5,
            redeemed_count: 1,
            infinity: false,
            organization_id: 3,
            dynamic_voucher: false,
            branch_id: 4,
            coupon_id: 6,
            tags: ['a'],
            extra: 'não sai',
          },
          SP,
        ),
      ).toEqual({
        id: 1,
        title: 'Promo',
        rules: 'regras',
        description: 'desc',
        url: null,
        discount: 10,
        start_date: '25/11/2026, 12:30:00',
        end_date: '24/12/2026, 23:00:00',
        working_days: [
          {
            week_day: 1,
            is_available: true,
            start_hour: '08:00',
            end_hour: '18:00',
          },
        ],
        quantity: 5,
        redeemed_count: 1,
        infinity: false,
        organization_id: 3,
        dynamic_voucher: false,
        branch_id: 4,
        coupon_id: 6,
        tags: ['a'],
      });
    });

    it('dias e tags que não são lista → listas vazias; sem datas → vazio', () => {
      expect(
        mapearPromocao({ id: 2, working_days: 'x', tags: null }, SP),
      ).toMatchObject({
        id: 2,
        start_date: '',
        end_date: '',
        working_days: [],
        tags: [],
      });
    });
  });
});

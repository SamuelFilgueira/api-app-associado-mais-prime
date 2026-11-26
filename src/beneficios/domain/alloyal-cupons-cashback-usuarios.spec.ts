import { mapearExtratoDeCashback } from 'src/beneficios/domain/alloyal-cashback';
import {
  mapearCupomDaFilial,
  mapearCupomDaOrganizacao,
  mapearDetalheDoCupom,
} from 'src/beneficios/domain/alloyal-cupons';
import {
  TAG_DO_APP,
  apenasDigitos,
  corpoDeCriacao,
  corpoDeReativacao,
  listaDeUsuarios,
  precisaReativar,
  usuarioPertenceAoCpf,
} from 'src/beneficios/domain/alloyal-usuarios';

const SP = 'America/Sao_Paulo';

describe('domínio Alloyal — cupons', () => {
  const bruto = {
    id: 1,
    template: 'online',
    title: 'Cupom',
    description: 'desc',
    cashback_text: null,
    online_payment_text: null,
    discount: 10,
    start_date: '2026-11-25T15:30:00.000Z',
    end_date: '2026-12-25T02:00:00.000Z',
    infinity: true,
    picture_small_url: 'p.png',
    picture_large_url: 'g.png',
    organization_id: 5,
    branch_id: 8,
    extra: 'não sai',
  };

  it('cupom da organização: 9 campos, datas em dd/mm/aaaa', () => {
    const cupom = mapearCupomDaOrganizacao(bruto, SP);

    expect(cupom).toEqual({
      id: 1,
      template: 'online',
      title: 'Cupom',
      description: 'desc',
      cashback_text: null,
      online_payment_text: null,
      discount: 10,
      start_date: '25/11/2026',
      end_date: '24/12/2026',
    });
    expect(Object.keys(cupom)).toEqual([
      'id',
      'template',
      'title',
      'description',
      'cashback_text',
      'online_payment_text',
      'discount',
      'start_date',
      'end_date',
    ]);
  });

  it('cupom da filial: o da organização mais imagens e vínculos, nessa ordem', () => {
    const cupom = mapearCupomDaFilial(bruto, SP);

    expect(cupom).toMatchObject({
      start_date: '25/11/2026',
      infinity: true,
      picture_small_url: 'p.png',
      picture_large_url: 'g.png',
      organization_id: 5,
      branch_id: 8,
    });
    expect(Object.keys(cupom).slice(9)).toEqual([
      'infinity',
      'picture_small_url',
      'picture_large_url',
      'organization_id',
      'branch_id',
    ]);
    expect(cupom).not.toHaveProperty('extra');
  });

  it('detalhe: datas em dd/mm/aaaa, dias de funcionamento como vieram', () => {
    const dias = [{ week_day: 1, is_available: true }];

    expect(
      mapearDetalheDoCupom(
        {
          id: 6,
          organization_name: 'Loja',
          organization_cover_image: 'capa.png',
          template: 'online',
          title: 'Cupom',
          description: 'desc',
          activation_url: '',
          rules: 'regras',
          cashback_text: '2%',
          discount: 10,
          start_date: '2026-11-25T15:30:00.000Z',
          end_date: null,
          code: 'ABC',
          picture_small_url: 'p.png',
          picture_large_url: 'g.png',
          working_days: dias,
          extra: 'não sai',
        },
        SP,
      ),
    ).toEqual({
      id: 6,
      organization_name: 'Loja',
      organization_cover_image: 'capa.png',
      template: 'online',
      title: 'Cupom',
      description: 'desc',
      activation_url: '',
      rules: 'regras',
      cashback_text: '2%',
      discount: 10,
      start_date: '25/11/2026',
      end_date: '',
      code: 'ABC',
      picture_small_url: 'p.png',
      picture_large_url: 'g.png',
      working_days: dias,
    });
  });
});

describe('domínio Alloyal — cashback', () => {
  it('converte para número e preenche o que a Alloyal omitir', () => {
    expect(
      mapearExtratoDeCashback({
        total_amount: '12.5',
        pending_amount: 1,
        available_amount: null,
        title: 'Seu cashback',
        cashback_records: [{ id: 1 }],
        extra: 'não sai',
      }),
    ).toEqual({
      total_amount: 12.5,
      pending_amount: 1,
      approved_amount: 0,
      available_amount: 0,
      in_transfer_amount: 0,
      transferred_amount: 0,
      title: 'Seu cashback',
      subtitle: '',
      status: '',
      cashback_records: [{ id: 1 }],
    });
  });

  it.each([null, undefined, '', [], 0])(
    'corpo sem os campos (%p) → tudo zerado',
    (corpo) => {
      expect(mapearExtratoDeCashback(corpo)).toEqual({
        total_amount: 0,
        pending_amount: 0,
        approved_amount: 0,
        available_amount: 0,
        in_transfer_amount: 0,
        transferred_amount: 0,
        title: '',
        subtitle: '',
        status: '',
        cashback_records: [],
      });
    },
  );

  it('lançamentos que não são lista → lista vazia', () => {
    expect(
      mapearExtratoDeCashback({ cashback_records: { id: 1 } }).cashback_records,
    ).toEqual([]);
  });
});

describe('domínio Alloyal — usuários', () => {
  const dados = {
    name: 'Fulano',
    cpf: '123.456.789-00',
    email: 'fulano@teste.local',
    password: 'x',
    extra: 'não sai',
  };

  it('cadastro leva a tag do app como TEXTO; reativação, como LISTA e sem o CPF', () => {
    expect(TAG_DO_APP).toBe('APP-ASSOCIADO');
    expect(corpoDeCriacao(dados)).toEqual({
      name: 'Fulano',
      cpf: '123.456.789-00',
      email: 'fulano@teste.local',
      password: 'x',
      user_tags: 'APP-ASSOCIADO',
    });
    expect(corpoDeReativacao(dados)).toEqual({
      name: 'Fulano',
      email: 'fulano@teste.local',
      password: 'x',
      active: true,
      user_tags: ['APP-ASSOCIADO'],
    });
  });

  it.each([
    [{ id: 1, active: false }, true],
    [{ id: 1, active: true }, false],
    [{ id: 1 }, false],
    [{ id: 1, active: null }, false],
    [{ id: 1, active: 0 }, false],
    [null, false],
    [undefined, false],
    ['texto', false],
  ])('precisaReativar(%p) → %s', (usuario, esperado) => {
    expect(precisaReativar(usuario)).toBe(esperado);
  });

  it('apenasDigitos aceita texto e número; o resto vira vazio', () => {
    expect(apenasDigitos('123.456.789-00')).toBe('12345678900');
    expect(apenasDigitos(900)).toBe('900');
    expect(apenasDigitos(null)).toBe('');
    expect(apenasDigitos({})).toBe('');
  });

  it('listaDeUsuarios: o que não é lista conta como ninguém', () => {
    expect(listaDeUsuarios([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(listaDeUsuarios({ users: [] })).toEqual([]);
    expect(listaDeUsuarios(null)).toEqual([]);
  });

  describe('usuarioPertenceAoCpf', () => {
    const CPF = '11122233344';

    it('id pedido de um usuário com o CPF do associado (com ou sem máscara) → sim', () => {
      expect(usuarioPertenceAoCpf([{ id: 900, cpf: CPF }], '900', CPF)).toBe(
        true,
      );
      expect(
        usuarioPertenceAoCpf(
          [{ id: '900', cpf: '111.222.333-44' }],
          '900',
          CPF,
        ),
      ).toBe(true);
    });

    it('id de outro usuário, ou do id pedido com outro CPF (homônimo) → não', () => {
      expect(usuarioPertenceAoCpf([{ id: 900, cpf: CPF }], '901', CPF)).toBe(
        false,
      );
      expect(
        usuarioPertenceAoCpf([{ id: 901, cpf: '55566677788' }], '901', CPF),
      ).toBe(false);
    });

    it('busca vazia, nula ou fora do formato → não', () => {
      expect(usuarioPertenceAoCpf([], '900', CPF)).toBe(false);
      expect(usuarioPertenceAoCpf(null, '900', CPF)).toBe(false);
      expect(usuarioPertenceAoCpf({ id: 900, cpf: CPF }, '900', CPF)).toBe(
        false,
      );
      expect(usuarioPertenceAoCpf([null, { id: 900 }], '900', CPF)).toBe(false);
    });
  });
});

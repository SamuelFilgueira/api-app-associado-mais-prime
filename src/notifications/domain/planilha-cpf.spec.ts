import {
  corrigirTextoUtf8,
  normalizarCpf,
  selecionarDestinatarios,
  separarCpfs,
  validarDigitosCpf,
} from 'src/notifications/domain/planilha-cpf';
import {
  emLotesDePush,
  ehJobDeAvulsos,
  posicoesPendentes,
} from 'src/notifications/domain/push-avulsos';

describe('planilha de CPFs — regras puras', () => {
  // Casos que estavam em `situacao-cadastro-notification.service.spec.ts`
  // (métodos privados do service); as expectativas são as mesmas.
  describe('validarDigitosCpf', () => {
    it('aceita CPFs com dígitos verificadores corretos', () => {
      expect(validarDigitosCpf('52998224725')).toBe(true);
      expect(validarDigitosCpf('01234567890')).toBe(true);
    });

    it('rejeita CPFs inválidos', () => {
      expect(validarDigitosCpf('52998224724')).toBe(false);
      expect(validarDigitosCpf('11111111111')).toBe(false);
      expect(validarDigitosCpf('123')).toBe(false);
    });
  });

  it('normalizarCpf tira a máscara e repõe o zero à esquerda', () => {
    expect(normalizarCpf('529.982.247-25')).toBe('52998224725');
    expect(normalizarCpf('1234567890')).toBe('01234567890');
    expect(normalizarCpf('abc')).toBeNull();
    expect(normalizarCpf('123456789012')).toBeNull();
  });

  it('separarCpfs: únicos válidos, inválidos e duplicados', () => {
    expect(
      separarCpfs([
        '529.982.247-25',
        '1234567890',
        '529.982.247-25',
        '111.111.111-11',
        'abc',
      ]),
    ).toEqual({
      cpfs: ['52998224725', '01234567890'],
      cpfsInvalidos: ['111.111.111-11', 'abc'],
      totalLinhas: 5,
      duplicadosRemovidos: 1,
    });
  });

  describe('selecionarDestinatarios', () => {
    const tokenValido = (t: unknown): t is string =>
      typeof t === 'string' && t.startsWith('ExponentPushToken[');

    it('recebe quem está cadastrado, ativo e com token válido; o resto sai com o motivo', () => {
      const selecao = selecionarDestinatarios(
        ['111', '222', '333', '444', '555'],
        [
          {
            id: 1,
            cpf: '111',
            isActive: true,
            expoPushToken: 'ExponentPushToken[a]',
          },
          {
            id: 2,
            cpf: '222',
            isActive: false,
            expoPushToken: 'ExponentPushToken[b]',
          },
          { id: 3, cpf: '333', isActive: true, expoPushToken: null },
          { id: 4, cpf: '444', isActive: true, expoPushToken: 'lixo' },
        ],
        tokenValido,
      );

      expect(selecao).toEqual({
        destinatarios: [
          { userId: 1, cpf: '111', expoPushToken: 'ExponentPushToken[a]' },
        ],
        cpfsNaoEncontrados: ['555'],
        cpfsInativos: ['222'],
        cpfsSemToken: ['333', '444'],
      });
    });
  });

  describe('corrigirTextoUtf8', () => {
    it('corrige texto com mojibake latin1 → utf8', () => {
      expect(corrigirTextoUtf8('AtualizaÃ§Ã£o de cadastro')).toBe(
        'Atualização de cadastro',
      );
      expect(corrigirTextoUtf8('Sua situaÃ§Ã£o Ã© InadimplÃªncia')).toBe(
        'Sua situação é Inadimplência',
      );
    });

    it('não altera texto já correto', () => {
      expect(corrigirTextoUtf8('Atualização de cadastro')).toBe(
        'Atualização de cadastro',
      );
      expect(corrigirTextoUtf8('SÃO PAULO')).toBe('SÃO PAULO');
      expect(corrigirTextoUtf8('')).toBe('');
    });

    it('corrige mojibake vindo de cp1252 (aspas curvas e travessão)', () => {
      expect(corrigirTextoUtf8('nÃ£o â€” atenÃ§Ã£o')).toBe('não — atenção');
    });
  });
});

describe('pushes avulsos em lote — regras puras', () => {
  it('emLotesDePush divide em grupos de até 100', () => {
    const lotes = emLotesDePush(Array.from({ length: 250 }, (_, i) => i));
    expect(lotes.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(lotes[2][49]).toBe(249);
    expect(emLotesDePush([])).toEqual([]);
  });

  it('ehJobDeAvulsos reconhece o payload com `mensagens`', () => {
    expect(ehJobDeAvulsos({ mensagens: [] })).toBe(true);
    expect(ehJobDeAvulsos({ userId: 1 })).toBe(false);
    expect(ehJobDeAvulsos(null)).toBe(false);
  });

  it('posicoesPendentes tira o que já tem resposta', () => {
    expect(posicoesPendentes(4, undefined)).toEqual([0, 1, 2, 3]);
    expect(
      posicoesPendentes(4, { resolvidos: [0, 2], semHistorico: [] }),
    ).toEqual([1, 3]);
  });
});

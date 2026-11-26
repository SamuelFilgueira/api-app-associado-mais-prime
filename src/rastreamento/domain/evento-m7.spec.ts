import {
  ehEventoAtrasado,
  extrairEventoM7,
  idDoJobDoEventoM7,
  instanteDoEvento,
} from 'src/rastreamento/domain/evento-m7';

describe('domínio — evento do webhook da M7', () => {
  // Fixture sintética, só com a FORMA do payload da M7.
  const evento = {
    codigo: '900001',
    chassi: '9BWZZZ377VT004251',
    monitorado: '10',
    evento: 'Ignição Ligada',
    tipoevento: 32,
    titulo: 'Alerta',
    canal: { identificacao: 'canal-x', nome: 'Canal X' },
    enviado_em: '2026-08-31T13:00:00.000Z',
  };

  it('extrai os campos usados pelo rastreamento', () => {
    expect(extrairEventoM7({ ...evento, scope: ' Cliente ' })).toMatchObject({
      chassi: '9BWZZZ377VT004251',
      evento: 'Ignição Ligada',
      tipoevento: 32,
      scope: 'cliente',
      codigo: '900001',
      enviadoEm: Date.parse('2026-08-31T13:00:00.000Z'),
    });
  });

  it('o hash é um SHA-256 em hexadecimal e o id do job não tem ":"', () => {
    const { hash } = extrairEventoM7(evento);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(idDoJobDoEventoM7(hash)).toBe(`m7-${hash}`);
    expect(idDoJobDoEventoM7(hash)).not.toContain(':');
  });

  it('reentrega do mesmo evento dá o mesmo hash, em qualquer ordem de chaves', () => {
    const reordenado = Object.fromEntries(Object.entries(evento).reverse());

    expect(extrairEventoM7(reordenado).hash).toBe(extrairEventoM7(evento).hash);
  });

  it('o canal da entrega (scope, canal, título) não muda o hash', () => {
    const original = extrairEventoM7(evento).hash;

    expect(extrairEventoM7({ ...evento, scope: 'cliente' }).hash).toBe(
      original,
    );
    expect(extrairEventoM7({ ...evento, scope: 'empresa' }).hash).toBe(
      original,
    );
    expect(
      extrairEventoM7({ ...evento, titulo: 'Outro', canal: { nome: 'Y' } })
        .hash,
    ).toBe(original);
  });

  it.each([
    ['chassi', { chassi: '9BWZZZ377VT000000' }],
    ['tipo', { tipoevento: 16 }],
    ['descrição', { evento: 'Violação de Âncora' }],
    ['código', { codigo: '900002' }],
    ['data de envio', { enviado_em: '2026-08-31T13:00:01.000Z' }],
  ])('%s diferente → outro evento', (_campo, mudanca) => {
    expect(extrairEventoM7({ ...evento, ...mudanca }).hash).not.toBe(
      extrairEventoM7(evento).hash,
    );
  });

  it('caixa e espaços do chassi e da descrição não criam outro evento', () => {
    expect(
      extrairEventoM7({
        ...evento,
        chassi: ' 9bwzzz377vt004251 ',
        evento: ' IGNIÇÃO LIGADA ',
      }).hash,
    ).toBe(extrairEventoM7(evento).hash);
  });

  it('payload sem chassi é identificado pelo conteúdo inteiro', () => {
    const aviso = { codigo: '1', tipo: 5, titulo: 'Aviso', enviado_em: 'x' };

    expect(extrairEventoM7(aviso).chassi).toBe('');
    expect(extrairEventoM7(aviso).hash).toBe(
      extrairEventoM7({ ...aviso }).hash,
    );
    expect(extrairEventoM7({ ...aviso, titulo: 'Outro' }).hash).not.toBe(
      extrairEventoM7(aviso).hash,
    );
  });

  it.each([null, undefined, 'texto', 42, []])(
    'payload que não é objeto (%p) não lança e não tem chassi',
    (payload) => {
      const lido = extrairEventoM7(payload);

      expect(lido.chassi).toBe('');
      expect(lido.hash).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it('tipoevento não numérico vira null; data inválida vira null', () => {
    const lido = extrairEventoM7({
      ...evento,
      tipoevento: 'abc',
      enviado_em: 'ontem',
    });

    expect(lido.tipoevento).toBeNull();
    expect(lido.enviadoEm).toBeNull();
  });

  it('instanteDoEvento aceita data com espaço', () => {
    expect(instanteDoEvento('2026-08-31 13:00:00')).toBe(
      new Date(2026, 7, 31, 13, 0, 0).getTime(),
    );
    expect(instanteDoEvento(undefined)).toBeNull();
  });

  describe('ehEventoAtrasado', () => {
    it('mais antigo que o último processado → descarta', () => {
      expect(ehEventoAtrasado(100, 200)).toBe(true);
    });

    it('igual ou mais novo → processa', () => {
      expect(ehEventoAtrasado(200, 200)).toBe(false);
      expect(ehEventoAtrasado(300, 200)).toBe(false);
    });

    it('sem uma das datas não há como afirmar: processa', () => {
      expect(ehEventoAtrasado(null, 200)).toBe(false);
      expect(ehEventoAtrasado(100, null)).toBe(false);
    });
  });
});

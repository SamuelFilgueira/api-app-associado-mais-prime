import {
  ContextoDaChamada,
  alloyalNaoConfigurada,
  erroDeCorpoAlloyal,
  erroDeFalhaAlloyal,
  erroDeStatusAlloyal,
  resultadoDaMetrica,
  resumirCorpo,
} from 'src/integrations/alloyal/alloyal.erro';
import { IntegrationError } from 'src/shared/erros/erros';

describe('classificação de erro da Alloyal', () => {
  const contexto: ContextoDaChamada = {
    operacao: 'cupom_resgatar',
    base: 'MAIS_PRIME',
  };

  describe('erroDeStatusAlloyal', () => {
    it.each([200, 201, 204, 299])('%i → sem erro', (status) => {
      expect(erroDeStatusAlloyal(contexto, status, {})).toBeNull();
    });

    it.each([
      [401, 'autenticacao', false],
      [403, 'autenticacao', false],
      [400, 'recusado', false],
      [404, 'recusado', false],
      [409, 'recusado', false],
      [422, 'recusado', false],
      [408, 'indisponivel', true],
      [429, 'indisponivel', true],
      [500, 'indisponivel', true],
      [502, 'indisponivel', true],
      [504, 'indisponivel', true],
      [302, 'resposta_invalida', false],
    ])('%i → %s (repetir: %s)', (status, tipo, transitoria) => {
      const erro = erroDeStatusAlloyal(contexto, status, { errors: ['x'] });

      expect(erro).toBeInstanceOf(IntegrationError);
      expect(erro).toMatchObject({
        vendor: 'alloyal',
        base: 'MAIS_PRIME',
        tipo,
        statusVendor: status,
        transitoria,
        detalhes: {
          operacao: 'cupom_resgatar',
          motivo: `Alloyal respondeu HTTP ${status}`,
          respostaVendor: '{"errors":["x"]}',
        },
      });
    });
  });

  describe('erroDeCorpoAlloyal', () => {
    it.each([
      ['lista', [], true],
      ['lista', [{ id: 1 }], true],
      ['lista', {}, false],
      ['lista', null, false],
      ['lista', '<html>', false],
      ['objeto', { id: 1 }, true],
      ['objeto', [], false],
      ['objeto', null, false],
      ['objeto', 'texto', false],
      ['json', { id: 1 }, true],
      ['json', [], true],
      ['json', null, true],
      ['json', undefined, true],
      ['json', '', true],
      ['json', '   ', true],
      ['json', 0, true],
      ['json', '<html>', false],
      ['ignorado', '<html>', true],
      ['ignorado', undefined, true],
    ] as const)(
      'espera %s, veio %p → aceito: %s',
      (esperado, corpo, aceito) => {
        const erro = erroDeCorpoAlloyal(contexto, esperado, 200, corpo);

        if (aceito) {
          expect(erro).toBeNull();
        } else {
          expect(erro).toMatchObject({
            tipo: 'resposta_invalida',
            statusVendor: 200,
            transitoria: false,
            detalhes: { operacao: 'cupom_resgatar' },
          });
        }
      },
    );
  });

  describe('erroDeFalhaAlloyal', () => {
    it.each(['ECONNABORTED', 'ETIMEDOUT'])('%s → timeout', (code) => {
      const falha = Object.assign(new Error('timeout of 20000ms exceeded'), {
        code,
      });

      expect(erroDeFalhaAlloyal(contexto, falha)).toMatchObject({
        tipo: 'timeout',
        transitoria: true,
        statusHttp: 504,
        detalhes: { motivo: `${code}: timeout of 20000ms exceeded` },
      });
    });

    it.each(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ERR_NETWORK'])(
      '%s → indisponivel',
      (code) => {
        const falha = Object.assign(new Error('falha de rede'), { code });

        expect(erroDeFalhaAlloyal(contexto, falha)).toMatchObject({
          tipo: 'indisponivel',
          transitoria: true,
          statusVendor: undefined,
        });
      },
    );

    it('erro sem código (ou que nem é Error) → indisponivel', () => {
      expect(erroDeFalhaAlloyal(contexto, new Error('quebrou'))).toMatchObject({
        tipo: 'indisponivel',
        detalhes: { motivo: 'quebrou' },
      });
      expect(erroDeFalhaAlloyal(contexto, 'texto')).toMatchObject({
        tipo: 'indisponivel',
        detalhes: { motivo: 'texto' },
      });
    });

    it('não guarda o erro do axios (o config dele tem as credenciais)', () => {
      const falha = Object.assign(new Error('falha'), {
        code: 'ECONNRESET',
        config: { headers: { 'api-secret': 'segredo-mp' } },
      });

      const erro = erroDeFalhaAlloyal(contexto, falha);

      expect(erro.causa).toBeUndefined();
      expect(JSON.stringify(erro)).not.toContain('segredo-mp');
    });

    it('erro já classificado passa como está', () => {
      const original = alloyalNaoConfigurada(contexto, 'BASE_URL_ALLOYAL');

      expect(erroDeFalhaAlloyal(contexto, original)).toBe(original);
    });
  });

  it('resumirCorpo: serializa, corta em 500 caracteres e aguenta o que não serializa', () => {
    expect(resumirCorpo(null)).toBe('(vazio)');
    expect(resumirCorpo('')).toBe('(vazio)');
    expect(resumirCorpo({ a: 1 })).toBe('{"a":1}');
    expect(resumirCorpo('x'.repeat(600))).toBe(
      `${'x'.repeat(500)}… (600 caracteres)`,
    );

    const circular: Record<string, unknown> = {};
    circular.eu = circular;
    expect(resumirCorpo(circular)).toBe('(não serializável)');
  });

  it('resultadoDaMetrica: só o timeout é contado à parte', () => {
    const prazo = erroDeFalhaAlloyal(
      contexto,
      Object.assign(new Error('t'), { code: 'ECONNABORTED' }),
    );

    expect(resultadoDaMetrica(prazo)).toBe('timeout');
    expect(resultadoDaMetrica(erroDeStatusAlloyal(contexto, 500, null))).toBe(
      'erro',
    );
    expect(resultadoDaMetrica(new Error('qualquer'))).toBe('erro');
  });
});

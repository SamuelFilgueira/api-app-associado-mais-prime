import {
  BoletoReativacaoDefinitivoError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';
import {
  ehStatusInstavel,
  erroDaExcecaoSga,
  erroDaRespostaSga,
} from 'src/sga/helpers/sga-instabilidade.helper';

describe('sga-instabilidade.helper', () => {
  it.each([401, 403, 408, 429, 500, 502, 503, 504])(
    'HTTP %i é instabilidade',
    (status) => {
      expect(ehStatusInstavel(status)).toBe(true);
      expect(erroDaRespostaSga('x', status, {})).toBeInstanceOf(
        BoletoReativacaoInstabilidadeError,
      );
    },
  );

  it.each([400, 404, 406, 409, 422])('HTTP %i é definitivo', (status) => {
    expect(ehStatusInstavel(status)).toBe(false);
    expect(erroDaRespostaSga('x', status, {})).toBeInstanceOf(
      BoletoReativacaoDefinitivoError,
    );
  });

  it('exceção de rede/timeout vira instabilidade com a etapa no texto', () => {
    const erro = erroDaExcecaoSga('boleto/cadastrar', new Error('timeout'));
    expect(erro).toBeInstanceOf(BoletoReativacaoInstabilidadeError);
    expect(erro.message).toContain('boleto/cadastrar');
    expect(erro.message).toContain('timeout');
  });

  it('erro já tipado passa inalterado', () => {
    const original = new BoletoReativacaoDefinitivoError('x', 'etapa', 404);
    expect(erroDaExcecaoSga('y', original)).toBe(original);
  });

  it('resume o corpo da resposta no texto do erro', () => {
    const erro = erroDaRespostaSga('associado/buscar', 500, {
      mensagem: 'erro interno',
    });
    expect(erro.message).toContain('HTTP 500');
    expect(erro.message).toContain('erro interno');
  });
});

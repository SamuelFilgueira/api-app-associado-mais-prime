import {
  deveAtualizarTotalGravado,
  interpretarTotalEconomizado,
} from 'src/economia/domain/total-economizado';

describe('total economizado (regra pura)', () => {
  it.each([
    ['112.5', 112.5],
    ['100', 100],
    ['0', 0],
    [87.25, 87.25],
    ['12.50 reais', 12.5],
  ])('interpreta %p como %p', (entrada, esperado) => {
    expect(interpretarTotalEconomizado(entrada)).toBe(esperado);
  });

  it.each([
    [undefined],
    [null],
    ['abc'],
    [''],
    [NaN],
    [Infinity],
    [{}],
    [true],
  ])('sem valor numérico (%p): null', (entrada) => {
    expect(interpretarTotalEconomizado(entrada)).toBeNull();
  });

  it('só atualiza o total gravado quando o lido é maior', () => {
    expect(deveAtualizarTotalGravado(112.5, 100)).toBe(true);
    expect(deveAtualizarTotalGravado(100, 100)).toBe(false);
    expect(deveAtualizarTotalGravado(80, 100)).toBe(false);
    expect(deveAtualizarTotalGravado(null, 100)).toBe(false);
  });
});

import {
  estadoEfetivo,
  lerBooleanoDeEntrada,
  valorAgregadoDoUsuario,
} from 'src/rastreamento/domain/estado-veiculo';
import {
  avisoDeHistoricoParcial,
  ehFalhaDeConsultaDoDia,
} from 'src/rastreamento/domain/historico-parcial';
import {
  ehDataIsoValida,
  problemaNoPeriodoDeHistorico,
} from 'src/rastreamento/domain/periodo-historico';

describe('domínio — estado de âncora e alerta de ignição', () => {
  const usuario = { ancoraAtiva: true, notificacaoIgnicao: false };

  it('vale o estado do veículo quando ele está definido', () => {
    expect(
      estadoEfetivo({ ancoraAtiva: false, notificacaoIgnicao: true }, usuario),
    ).toEqual({ ancoraAtiva: false, notificacaoIgnicao: true });
  });

  it('veículo ainda null → vale o valor do usuário, campo a campo', () => {
    expect(
      estadoEfetivo({ ancoraAtiva: null, notificacaoIgnicao: null }, usuario),
    ).toEqual(usuario);
    expect(
      estadoEfetivo({ ancoraAtiva: false, notificacaoIgnicao: null }, usuario),
    ).toEqual({ ancoraAtiva: false, notificacaoIgnicao: false });
  });

  it('o valor do usuário é "algum veículo ligado"', () => {
    expect(valorAgregadoDoUsuario([false, true])).toBe(true);
    expect(valorAgregadoDoUsuario([false, false])).toBe(false);
    expect(valorAgregadoDoUsuario([])).toBe(false);
  });

  it.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    [' TRUE ', true],
    ['0', false],
  ])('lerBooleanoDeEntrada(%p) = %p', (entrada, esperado) => {
    expect(lerBooleanoDeEntrada(entrada)).toBe(esperado);
  });

  it.each([2, 'talvez', null, undefined, {}])(
    'lerBooleanoDeEntrada(%p) não reconhece → null',
    (entrada) => {
      expect(lerBooleanoDeEntrada(entrada)).toBeNull();
    },
  );
});

describe('domínio — histórico parcial', () => {
  it.each([
    [undefined, true],
    [500, true],
    [503, true],
    [408, true],
    [429, true],
    [404, false],
    [400, false],
  ])('status %p é falha de consulta? %p', (status, esperado) => {
    expect(ehFalhaDeConsultaDoDia(status)).toBe(esperado);
  });

  it('sem falhas → parcial false e lista vazia', () => {
    expect(avisoDeHistoricoParcial([])).toEqual({
      parcial: false,
      diasComFalha: [],
    });
  });

  it('lista os dias com falha em ordem, sem repetir', () => {
    expect(avisoDeHistoricoParcial([20260803, 20260801, 20260803])).toEqual({
      parcial: true,
      diasComFalha: ['2026-08-01', '2026-08-03'],
    });
  });
});

describe('domínio — período de histórico', () => {
  it('data ISO precisa existir no calendário', () => {
    expect(ehDataIsoValida('2026-02-28')).toBe(true);
    expect(ehDataIsoValida('2026-02-30')).toBe(false);
    expect(ehDataIsoValida('28/02/2026')).toBe(false);
    expect(ehDataIsoValida(undefined)).toBe(false);
  });

  it('período correto → sem problema', () => {
    expect(
      problemaNoPeriodoDeHistorico('CHASSI', '2026-08-01', '2026-08-01'),
    ).toBeNull();
  });

  it('aponta o primeiro problema, com o texto de sempre', () => {
    expect(problemaNoPeriodoDeHistorico('', '2026-08-01', '2026-08-02')).toBe(
      'Parâmetro chassi é obrigatório',
    );
    expect(
      problemaNoPeriodoDeHistorico('CHASSI', '2026-08-03', '2026-08-02'),
    ).toBe('Parâmetro dataInicial não pode ser maior que dataFinal');
  });
});

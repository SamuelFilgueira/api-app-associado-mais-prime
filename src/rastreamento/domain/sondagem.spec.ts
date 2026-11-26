import {
  planejarSondagem,
  precisaRevalidar,
} from 'src/rastreamento/domain/sondagem';

describe('domínio — plano de sondagem dos provedores', () => {
  const TODOS = ['logica', 'm7', 'softruck'];
  const memoria = (provedor: string | null, falhas = 0) => ({
    provedor,
    falhas,
    verificadoEm: 1,
  });

  it('veículo sem vínculo local → todos', () => {
    expect(planejarSondagem(null, TODOS, 3)).toEqual({
      tipo: 'todos',
      provedores: TODOS,
    });
  });

  it('vínculo sem provedor gravado → todos', () => {
    expect(planejarSondagem(memoria(null), TODOS, 3).tipo).toBe('todos');
  });

  it('provedor gravado e saudável → só ele, os demais de reserva', () => {
    expect(planejarSondagem(memoria('m7', 2), TODOS, 3)).toEqual({
      tipo: 'conhecido',
      provedor: 'm7',
      demais: ['logica', 'softruck'],
    });
  });

  it('falhas seguidas no limite → todos', () => {
    expect(planejarSondagem(memoria('m7', 3), TODOS, 3).tipo).toBe('todos');
  });

  it('provedor gravado sem credencial na base → todos os configurados', () => {
    expect(planejarSondagem(memoria('softruck'), ['m7'], 3)).toEqual({
      tipo: 'todos',
      provedores: ['m7'],
    });
  });

  describe('precisaRevalidar', () => {
    const janelas = { posicaoParadaMs: 900, emMovimentoMs: 600, paradoMs: 60 };
    const AGORA = 10_000;

    it('nunca verificado → sim', () => {
      expect(
        precisaRevalidar(
          { agora: AGORA, verificadoEm: null, timestampDaPosicao: AGORA },
          janelas,
        ),
      ).toBe(true);
    });

    it('posição recente: usa a janela longa', () => {
      const entrada = (verificadoHa: number) => ({
        agora: AGORA,
        verificadoEm: AGORA - verificadoHa,
        timestampDaPosicao: AGORA - 10,
      });
      expect(precisaRevalidar(entrada(600), janelas)).toBe(false);
      expect(precisaRevalidar(entrada(601), janelas)).toBe(true);
    });

    it('posição parada no tempo: usa a janela curta', () => {
      const entrada = (verificadoHa: number) => ({
        agora: AGORA,
        verificadoEm: AGORA - verificadoHa,
        timestampDaPosicao: AGORA - 901,
      });
      expect(precisaRevalidar(entrada(60), janelas)).toBe(false);
      expect(precisaRevalidar(entrada(61), janelas)).toBe(true);
    });
  });
});

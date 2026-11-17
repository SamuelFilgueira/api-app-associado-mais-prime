import {
  calcularJanelaRaspada,
  dentroDaJanelaDeLembrete,
  deveLembrarRaspada,
} from 'src/associado-sorte/helpers/sorte-raspadinha.helper';

/** Instante a partir de "yyyy-mm-ddTHH:MM" em São Paulo. */
const sp = (texto: string) => new Date(`${texto}:00.000-03:00`);

describe('calcularJanelaRaspada', () => {
  const base = { raspadasPorDia: 2, intervaloMinimoMinutos: 60 };

  it('sem raspada hoje: liberada desde 00:00', () => {
    const j = calcularJanelaRaspada({
      ...base,
      agora: sp('2026-11-20T10:00'),
      raspadasHoje: 0,
      ultimaRaspadaHojeEm: null,
    });
    expect(j).toEqual({
      raspadasHoje: 0,
      raspadasRestantesHoje: 2,
      proximaRaspadaEm: sp('2026-11-20T00:00'),
      bloqueio: null,
    });
  });

  it('intervalo: bloqueia até última + 60 min', () => {
    const j = calcularJanelaRaspada({
      ...base,
      agora: sp('2026-11-20T10:30'),
      raspadasHoje: 1,
      ultimaRaspadaHojeEm: sp('2026-11-20T10:00'),
    });
    expect(j.bloqueio).toBe('INTERVALO');
    expect(j.proximaRaspadaEm).toEqual(sp('2026-11-20T11:00'));
  });

  it('limite diário: próxima na virada do dia em São Paulo', () => {
    const j = calcularJanelaRaspada({
      ...base,
      agora: sp('2026-11-20T23:30'),
      raspadasHoje: 2,
      ultimaRaspadaHojeEm: sp('2026-11-20T22:00'),
    });
    expect(j.bloqueio).toBe('LIMITE_DIARIO');
    expect(j.proximaRaspadaEm).toEqual(sp('2026-11-21T00:00'));
  });

  it('intervalo que passa da meia-noite: libera à 00:00', () => {
    const j = calcularJanelaRaspada({
      ...base,
      agora: sp('2026-11-20T23:30'),
      raspadasHoje: 1,
      ultimaRaspadaHojeEm: sp('2026-11-20T23:20'),
    });
    expect(j.bloqueio).toBe('INTERVALO');
    expect(j.proximaRaspadaEm).toEqual(sp('2026-11-21T00:00'));
  });
});

describe('janela e decisão do lembrete', () => {
  it('janela [08:00, 21:00) em São Paulo', () => {
    expect(
      dentroDaJanelaDeLembrete(sp('2026-11-20T07:59'), '08:00', '21:00'),
    ).toBe(false);
    expect(
      dentroDaJanelaDeLembrete(sp('2026-11-20T08:00'), '08:00', '21:00'),
    ).toBe(true);
    expect(
      dentroDaJanelaDeLembrete(sp('2026-11-20T20:59'), '08:00', '21:00'),
    ).toBe(true);
    expect(
      dentroDaJanelaDeLembrete(sp('2026-11-20T21:00'), '08:00', '21:00'),
    ).toBe(false);
  });

  it('janela que passa da meia-noite', () => {
    expect(
      dentroDaJanelaDeLembrete(sp('2026-11-20T23:00'), '22:00', '02:00'),
    ).toBe(true);
    expect(
      dentroDaJanelaDeLembrete(sp('2026-11-20T01:00'), '22:00', '02:00'),
    ).toBe(true);
    expect(
      dentroDaJanelaDeLembrete(sp('2026-11-20T12:00'), '22:00', '02:00'),
    ).toBe(false);
  });

  it('avisa uma vez por liberação', () => {
    const params = {
      agora: sp('2026-11-20T08:00'),
      raspadasHoje: 0,
      ultimaRaspadaHojeEm: null,
      raspadasPorDia: 3,
      intervaloMinimoMinutos: 60,
    };
    const primeira = deveLembrarRaspada({ ...params, lembreteRaspadaEm: null });
    expect(primeira).toEqual({
      lembrar: true,
      liberacao: sp('2026-11-20T00:00'),
    });
    // A liberação da 00:00 já foi avisada.
    expect(
      deveLembrarRaspada({
        ...params,
        lembreteRaspadaEm: sp('2026-11-20T00:00'),
      }).lembrar,
    ).toBe(false);
    // Aviso de ontem não impede o de hoje.
    expect(
      deveLembrarRaspada({
        ...params,
        lembreteRaspadaEm: sp('2026-11-19T10:00'),
      }).lembrar,
    ).toBe(true);
  });
});

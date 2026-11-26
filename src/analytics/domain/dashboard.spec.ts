import {
  MENSAGEM_DE_INTERVALO_INVALIDO,
  janelasDaAudiencia,
  montarAudiencia,
  montarOverview,
  rankingDeAcoes,
  rankingDeTelas,
  resolverIntervalo,
  resumoDeFormularios,
  serieDeSessoes,
  totalPorAcao,
} from 'src/analytics/domain/dashboard';

describe('dashboards (regra pura)', () => {
  describe('resolverIntervalo', () => {
    const agora = new Date('2026-07-31T12:00:00.000Z');

    it('`from` e `to` informados', () => {
      expect(
        resolverIntervalo({ from: '2026-07-01', to: '2026-07-31' }, agora),
      ).toEqual({
        from: new Date('2026-07-01'),
        to: new Date('2026-07-31'),
      });
    });

    it('sem `to`: até agora; sem `from`: 30 dias antes do fim', () => {
      expect(resolverIntervalo({}, agora)).toEqual({
        from: new Date('2026-07-01T12:00:00.000Z'),
        to: agora,
      });
      expect(resolverIntervalo({ to: '2026-07-31' }, agora)).toEqual({
        from: new Date('2026-07-01'),
        to: new Date('2026-07-31'),
      });
    });

    it('`from` depois de `to` e intervalo acima de 366 dias são recusados', () => {
      expect(
        resolverIntervalo({ from: '2026-08-01', to: '2026-07-01' }, agora),
      ).toBe('FROM_DEPOIS_DE_TO');
      expect(
        resolverIntervalo({ from: '2025-07-30', to: '2026-07-31' }, agora),
      ).toEqual({ from: new Date('2025-07-30'), to: new Date('2026-07-31') });
      expect(
        resolverIntervalo({ from: '2025-07-29', to: '2026-07-31' }, agora),
      ).toBe('INTERVALO_MAIOR_QUE_O_LIMITE');
    });

    it('as mensagens ao painel são as de sempre', () => {
      expect(MENSAGEM_DE_INTERVALO_INVALIDO).toEqual({
        FROM_DEPOIS_DE_TO: '"from" deve ser anterior a "to"',
        INTERVALO_MAIOR_QUE_O_LIMITE: 'Intervalo máximo de consulta é 12 meses',
      });
    });
  });

  it('rankingDeTelas soma por tela, ordena por visualizações e calcula a média', () => {
    expect(
      rankingDeTelas([
        { screen: 'a', viewCount: 3, totalTimeMs: 100 },
        { screen: 'b', viewCount: 9, totalTimeMs: 90 },
        { screen: 'a', viewCount: 1, totalTimeMs: 101 },
        { screen: 'c', viewCount: 0, totalTimeMs: 0 },
      ]),
    ).toEqual([
      { screen: 'b', viewCount: 9, totalTimeMs: 90, avgTimeMs: 10 },
      { screen: 'a', viewCount: 4, totalTimeMs: 201, avgTimeMs: 50 },
      { screen: 'c', viewCount: 0, totalTimeMs: 0, avgTimeMs: 0 },
    ]);
  });

  it('totalPorAcao e rankingDeAcoes', () => {
    const totais = totalPorAcao([
      { action: 'x', count: 1 },
      { action: 'y', count: 4 },
      { action: 'x', count: 2 },
    ]);

    expect(totais.get('x')).toBe(3);
    expect(rankingDeAcoes(totais)).toEqual([
      { action: 'y', count: 4 },
      { action: 'x', count: 3 },
    ]);
  });

  it('resumoDeFormularios: taxas com duas casas; sem envios, zero', () => {
    const linha = (form: string, s: number, ok: number, erro: number) => ({
      screen: 'screen_login',
      form,
      startedCount: 10,
      submittedCount: s,
      successCount: ok,
      errorCount: erro,
    });

    expect(
      resumoDeFormularios([
        linha('form_login', 2, 1, 1),
        linha('form_login', 1, 1, 0),
        linha('form_trocar_senha', 0, 0, 0),
      ]),
    ).toEqual([
      {
        screen: 'screen_login',
        form: 'form_login',
        startedCount: 20,
        submittedCount: 3,
        successCount: 2,
        errorCount: 1,
        successRate: 66.67,
        errorRate: 33.33,
      },
      {
        screen: 'screen_login',
        form: 'form_trocar_senha',
        startedCount: 10,
        submittedCount: 0,
        successCount: 0,
        errorCount: 0,
        successRate: 0,
        errorRate: 0,
      },
    ]);
  });

  it('montarOverview corta os rankings em 10 DEPOIS de somar', () => {
    const overview = montarOverview({
      sessoes: { sessionsCount: null, installsCount: 7 },
      acoes: [
        { action: 'auth_login_success', count: 2 },
        { action: 'auth_login_success', count: 3 },
      ],
      telas: [
        // 11 telas com 2 visualizações por dia + uma que só as ultrapassa
        // depois de somados os três dias (3).
        ...Array.from({ length: 11 }, (_, i) => ({
          screen: `screen_${i}`,
          viewCount: 2,
          totalTimeMs: 10,
        })),
        { screen: 'screen_somada', viewCount: 1, totalTimeMs: 10 },
        { screen: 'screen_somada', viewCount: 1, totalTimeMs: 10 },
        { screen: 'screen_somada', viewCount: 1, totalTimeMs: 10 },
      ],
    });

    expect(overview.totalSessions).toBe(0);
    expect(overview.totalInstalls).toBe(7);
    expect(overview.totalLoginSuccess).toBe(5);
    expect(overview.topScreens).toHaveLength(10);
    expect(overview.topScreens[0]).toMatchObject({
      screen: 'screen_somada',
      viewCount: 3,
    });
    expect(overview.topActions).toEqual([
      { action: 'auth_login_success', count: 5 },
    ]);
  });

  it('serieDeSessoes devolve o dia em AAAA-MM-DD', () => {
    expect(
      serieDeSessoes([
        {
          day: new Date('2026-07-01T00:00:00.000Z'),
          platform: 'ios',
          appVersion: '2.0.0',
          sessionsCount: 8,
          installsCount: 3,
        },
      ]),
    ).toEqual([
      {
        day: '2026-07-01',
        platform: 'ios',
        appVersion: '2.0.0',
        sessionsCount: 8,
        installsCount: 3,
      },
    ]);
  });

  describe('audiência', () => {
    const janelas = janelasDaAudiencia({
      from: new Date('2026-06-29T10:00:00.000Z'),
      to: new Date('2026-07-28T23:00:00.000Z'),
    });

    it('janelas: período em dias inteiros e WAU/MAU fixos no fim do período', () => {
      expect(janelas).toEqual({
        dayFrom: new Date('2026-06-29T00:00:00.000Z'),
        dayTo: new Date('2026-07-28T00:00:00.000Z'),
        days: 30,
        wauFrom: new Date('2026-07-22T00:00:00.000Z'),
        mauFrom: new Date('2026-06-29T00:00:00.000Z'),
      });
    });

    it('converte BigInt, ordena por aparelhos únicos e calcula DAU e stickiness', () => {
      const audiencia = montarAudiencia(janelas, {
        aparelhos: [
          {
            platform: 'ios',
            uniqueDevices: 10n,
            deviceDays: 30n,
            wau: 5n,
            mau: 10n,
          },
          {
            platform: 'android',
            uniqueDevices: 20n,
            deviceDays: 60n,
            wau: 8n,
            mau: 20n,
          },
        ],
        sessoes: [{ platform: 'android', uniqueSessions: 50n }],
        novos: [{ platform: 'ios', newDevices: 4n }],
        novosPorDia: [
          {
            day: new Date('2026-07-01T00:00:00.000Z'),
            platform: 'ios',
            count: 4n,
          },
        ],
      });

      expect(audiencia.from).toBe('2026-06-29');
      expect(audiencia.to).toBe('2026-07-28');
      expect(audiencia.platforms.map((p) => p.platform)).toEqual([
        'android',
        'ios',
      ]);
      expect(audiencia.platforms[0]).toEqual({
        platform: 'android',
        uniqueDevices: 20,
        uniqueSessions: 50,
        deviceDays: 60,
        newDevices: 0,
        avgDailyDevices: 2,
        sessionsPerDevice: 2.5,
        avgActiveDaysPerDevice: 3,
      });
      expect(audiencia.totals).toEqual({
        uniqueDevices: 30,
        uniqueSessions: 50,
        deviceDays: 90,
        newDevices: 4,
        avgDailyDevices: 3,
        wau: 13,
        mau: 30,
        stickiness: 10,
      });
      expect(audiencia.newDevicesDaily).toEqual([
        { day: '2026-07-01', platform: 'ios', count: 4 },
      ]);
    });

    it('sem dados: tudo zero, nenhuma divisão por zero', () => {
      expect(
        montarAudiencia(janelas, {
          aparelhos: [],
          sessoes: [],
          novos: [],
          novosPorDia: [],
        }).totals,
      ).toEqual({
        uniqueDevices: 0,
        uniqueSessions: 0,
        deviceDays: 0,
        newDevices: 0,
        avgDailyDevices: 0,
        wau: 0,
        mau: 0,
        stickiness: 0,
      });
    });
  });
});

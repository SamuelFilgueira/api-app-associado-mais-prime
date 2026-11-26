import {
  MENSAGEM_DE_PERIODO_INVALIDO,
  excedeTamanhoMaximo,
  filtrarPelasAllowlists,
  montarResumoSanitizado,
  normalizarIdDoUsuario,
  validarPeriodo,
} from 'src/analytics/domain/resumo-recebido';

describe('summary recebido (regra pura)', () => {
  describe('tamanho', () => {
    it('64 KB é o limite: exatamente no limite passa, um caractere a mais não', () => {
      expect(excedeTamanhoMaximo('x'.repeat(64 * 1024))).toBe(false);
      expect(excedeTamanhoMaximo('x'.repeat(64 * 1024 + 1))).toBe(true);
    });
  });

  describe('validarPeriodo', () => {
    const inicio = new Date('2024-01-01T00:00:00Z');

    it('aceita janela de até 1 hora', () => {
      expect(
        validarPeriodo(inicio, new Date('2024-01-01T00:30:00Z')),
      ).toBeNull();
      expect(
        validarPeriodo(inicio, new Date('2024-01-01T01:00:00Z')),
      ).toBeNull();
    });

    it.each([
      [new Date('x'), new Date('2024-01-01T00:30:00Z'), 'DATAS_INVALIDAS'],
      [inicio, new Date('x'), 'DATAS_INVALIDAS'],
      [inicio, inicio, 'FIM_NAO_POSTERIOR_AO_INICIO'],
      [inicio, new Date('2023-12-31T23:00:00Z'), 'FIM_NAO_POSTERIOR_AO_INICIO'],
      [
        inicio,
        new Date('2024-01-01T01:00:00.001Z'),
        'JANELA_MAIOR_QUE_O_LIMITE',
      ],
    ])('recusa %p → %p com %s', (a, b, motivo) => {
      expect(validarPeriodo(a, b)).toBe(motivo);
    });

    it('as mensagens ao app são as de sempre', () => {
      expect(MENSAGEM_DE_PERIODO_INVALIDO).toEqual({
        DATAS_INVALIDAS: 'Datas inválidas no payload',
        FIM_NAO_POSTERIOR_AO_INICIO:
          'period_end deve ser maior que period_start',
        JANELA_MAIOR_QUE_O_LIMITE: 'Janela de período excede 1 hora',
      });
    });
  });

  describe('filtrarPelasAllowlists', () => {
    it('descarta o que está fora das allowlists e conta os descartes', () => {
      const aceitos = filtrarPelasAllowlists({
        screens: [
          { screen: 'screen_home', view_count: 1, total_time_ms: 10 },
          { screen: 'screen_inexistente', view_count: 1, total_time_ms: 10 },
        ],
        actions: [
          { action: 'auth_login_success', count: 1 },
          { action: 'acao_inexistente', count: 1 },
          { action: 'outra_inexistente', count: 1 },
        ],
        forms: [
          {
            screen: 'screen_login',
            form: 'form_login',
            started_count: 1,
            submitted_count: 1,
            success_count: 1,
            error_count: 0,
          },
          {
            screen: 'screen_login',
            form: 'form_inexistente',
            started_count: 1,
            submitted_count: 0,
            success_count: 0,
            error_count: 0,
          },
        ],
      });

      expect(aceitos.screens.map((s) => s.screen)).toEqual(['screen_home']);
      expect(aceitos.actions.map((a) => a.action)).toEqual([
        'auth_login_success',
      ]);
      expect(aceitos.forms.map((f) => f.form)).toEqual(['form_login']);
      expect(aceitos.descartados).toBe(4);
    });

    it('limita os contadores às faixas aceitas', () => {
      const aceitos = filtrarPelasAllowlists({
        screens: [
          { screen: 'screen_home', view_count: 99_999, total_time_ms: 9e9 },
        ],
        actions: [{ action: 'auth_logout', count: -5 }],
        forms: [
          {
            screen: 'screen_login',
            form: 'form_login',
            started_count: 10_000,
            submitted_count: 2.9,
            success_count: Number.NaN,
            error_count: 3,
          },
        ],
      });

      expect(aceitos.screens[0]).toEqual({
        screen: 'screen_home',
        view_count: 9999,
        total_time_ms: 3_600_000,
      });
      expect(aceitos.actions[0]).toEqual({ action: 'auth_logout', count: 0 });
      expect(aceitos.forms[0]).toMatchObject({
        started_count: 9999,
        submitted_count: 2,
        success_count: 0,
        error_count: 3,
      });
    });

    it('sem `forms` no corpo: lista vazia, nenhum descarte', () => {
      expect(filtrarPelasAllowlists({ screens: [], actions: [] })).toEqual({
        screens: [],
        actions: [],
        forms: [],
        descartados: 0,
      });
    });

    it('só as chaves conhecidas de cada item seguem adiante', () => {
      const aceitos = filtrarPelasAllowlists({
        screens: [
          {
            screen: 'screen_home',
            view_count: 1,
            total_time_ms: 1,
            extra: 'x',
          } as never,
        ],
        actions: [],
      });

      expect(Object.keys(aceitos.screens[0])).toEqual([
        'screen',
        'view_count',
        'total_time_ms',
      ]);
    });
  });

  it('montarResumoSanitizado: chaves na ordem do hash, versões aparadas', () => {
    const resumo = montarResumoSanitizado({
      periodStart: '2024-01-01T00:00:00Z',
      periodEnd: '2024-01-01T00:30:00Z',
      platform: 'android',
      version: '  1.0.0  ',
      runtimeVersion: undefined,
      installHash: 'i'.repeat(64),
      sessionHash: 's'.repeat(64),
      aceitos: { screens: [], actions: [], forms: [] },
    });

    expect(Object.keys(resumo)).toEqual([
      'period_start',
      'period_end',
      'platform',
      'app_version',
      'runtime_version',
      'install_hash',
      'session_hash',
      'screens',
      'actions',
      'forms',
    ]);
    expect(resumo.app_version).toBe('1.0.0');
    expect(resumo.runtime_version).toBeUndefined();
  });

  it.each([
    [123, 123],
    ['456', 456],
    ['abc', null],
    [0, null],
    [-1, null],
    [1.5, null],
    [undefined, null],
    [null, null],
  ])('normalizarIdDoUsuario(%p) = %p', (entrada, esperado) => {
    expect(normalizarIdDoUsuario(entrada)).toBe(esperado);
  });
});

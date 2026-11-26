import {
  DadosDoResumo,
  incrementoDaSessaoDiaria,
  linhasDeAcao,
  linhasDeFormulario,
  linhasDeTela,
  montarPlanoDaJornada,
  montarPlanoDeIngestao,
  ultimoHorarioDaAcao,
} from 'src/analytics/domain/agregados-diarios';
import type { SanitizedJourneyEvent } from 'src/analytics/utils/analytics-journey.util';

const evento = (
  parcial: Partial<SanitizedJourneyEvent> &
    Pick<SanitizedJourneyEvent, 't' | 'type' | 'event'>,
): SanitizedJourneyEvent => ({
  duration_ms: null,
  screen: null,
  outcome: null,
  ...parcial,
});

const dados = (extra: Partial<DadosDoResumo> = {}): DadosDoResumo => ({
  sanitizedPayload: {
    period_start: '2026-07-01T15:00:00.000Z',
    period_end: '2026-07-01T15:30:00.000Z',
    platform: 'android',
    app_version: '2.1.0',
    runtime_version: '49.0.0',
    install_hash: 'i'.repeat(64),
    session_hash: 's'.repeat(64),
    screens: [{ screen: 'screen_home', view_count: 2, total_time_ms: 5000 }],
    actions: [{ action: 'auth_login_success', count: 1 }],
    forms: [],
  },
  installHash: 'i'.repeat(64),
  sessionHash: 's'.repeat(64),
  payloadHash: 'p'.repeat(64),
  discardedItemsCount: 0,
  acceptedScreensCount: 1,
  acceptedActionsCount: 1,
  acceptedFormsCount: 0,
  analyticsUserId: null,
  ...extra,
});

describe('agregados diários (regra pura)', () => {
  describe('linhasDeTela', () => {
    it('uma linha por tela, com os nomes de coluna do agregado', () => {
      expect(
        linhasDeTela([
          { screen: 'screen_login', view_count: 1, total_time_ms: 1000 },
          { screen: 'screen_home', view_count: 2, total_time_ms: 5000 },
        ]),
      ).toEqual([
        { screen: 'screen_home', viewCount: 2, totalTimeMs: 5000 },
        { screen: 'screen_login', viewCount: 1, totalTimeMs: 1000 },
      ]);
    });

    it('tela repetida no mesmo summary é somada (como os upserts em sequência somavam)', () => {
      expect(
        linhasDeTela([
          { screen: 'screen_home', view_count: 1, total_time_ms: 100 },
          { screen: 'screen_perfil', view_count: 9, total_time_ms: 9 },
          { screen: 'screen_home', view_count: 4, total_time_ms: 400 },
        ]),
      ).toEqual([
        { screen: 'screen_home', viewCount: 5, totalTimeMs: 500 },
        { screen: 'screen_perfil', viewCount: 9, totalTimeMs: 9 },
      ]);
    });

    it('a ordem de saída não depende da ordem de chegada', () => {
      const a = linhasDeTela([
        { screen: 'screen_b', view_count: 1, total_time_ms: 1 },
        { screen: 'screen_a', view_count: 1, total_time_ms: 1 },
      ]);
      const b = linhasDeTela([
        { screen: 'screen_a', view_count: 1, total_time_ms: 1 },
        { screen: 'screen_b', view_count: 1, total_time_ms: 1 },
      ]);

      expect(a).toEqual(b);
    });

    it('sem telas: nenhuma linha (nenhum comando é emitido)', () => {
      expect(linhasDeTela([])).toEqual([]);
    });
  });

  it('linhasDeAcao soma as repetidas e ordena', () => {
    expect(
      linhasDeAcao([
        { action: 'auth_logout', count: 1 },
        { action: 'auth_login_success', count: 2 },
        { action: 'auth_logout', count: 3 },
      ]),
    ).toEqual([
      { action: 'auth_login_success', count: 2 },
      { action: 'auth_logout', count: 4 },
    ]);
  });

  it('linhasDeFormulario: a chave é tela + formulário', () => {
    const form = (screen: string, n: number) => ({
      screen,
      form: 'form_login',
      started_count: n,
      submitted_count: n,
      success_count: n,
      error_count: 0,
    });

    expect(
      linhasDeFormulario([
        form('screen_login', 1),
        form('screen_primeiro_acesso', 5),
        form('screen_login', 2),
      ]),
    ).toEqual([
      {
        screen: 'screen_login',
        form: 'form_login',
        startedCount: 3,
        submittedCount: 3,
        successCount: 3,
        errorCount: 0,
      },
      {
        screen: 'screen_primeiro_acesso',
        form: 'form_login',
        startedCount: 5,
        submittedCount: 5,
        successCount: 5,
        errorCount: 0,
      },
    ]);
  });

  describe('incrementoDaSessaoDiaria', () => {
    it.each([
      [true, true, { sessionsCount: 1, installsCount: 1 }],
      [true, false, { sessionsCount: 1, installsCount: 0 }],
      [false, true, { sessionsCount: 0, installsCount: 1 }],
    ])('sessão nova=%p, instalação nova=%p', (sessao, instalacao, esperado) => {
      expect(
        incrementoDaSessaoDiaria({
          sessaoNovaNoDia: sessao,
          instalacaoNovaNoDia: instalacao,
        }),
      ).toEqual(esperado);
    });

    it('as duas já contadas no dia: nada a somar', () => {
      expect(
        incrementoDaSessaoDiaria({
          sessaoNovaNoDia: false,
          instalacaoNovaNoDia: false,
        }),
      ).toBeNull();
    });
  });

  describe('jornada', () => {
    const eventos = [
      evento({
        t: '2026-07-01T15:01:00.000Z',
        type: 'screen',
        event: 'screen_home',
        duration_ms: 3000,
      }),
      evento({
        t: '2026-07-01T15:02:00.000Z',
        type: 'action',
        event: 'auth_login_success',
      }),
      evento({
        t: '2026-07-01T15:09:00.000Z',
        type: 'action',
        event: 'auth_login_success',
      }),
      evento({
        t: '2026-07-01T15:05:00.000Z',
        type: 'form',
        event: 'form_login',
        screen: 'screen_login',
        outcome: 'success',
      }),
    ];

    it('ultimoHorarioDaAcao pega o mais recente e ignora telas/formulários de mesmo nome', () => {
      expect(ultimoHorarioDaAcao(eventos, 'auth_login_success')).toEqual(
        new Date('2026-07-01T15:09:00.000Z'),
      );
      expect(ultimoHorarioDaAcao(eventos, 'auth_logout')).toBeNull();
      expect(ultimoHorarioDaAcao(eventos, 'screen_home')).toBeNull();
    });

    it('montarPlanoDaJornada: login/logout inferidos, eventos na ordem recebida com `seq`', () => {
      const plano = montarPlanoDaJornada({
        device: {
          brand: 'Samsung',
          model: 'SM-A155M',
          model_id: null,
          os_name: 'Android',
          os_version: '14',
          device_type: null,
          timezone: null,
        },
        clientIp: '10.0.0.5',
        events: eventos,
      });

      expect(plano.loginEm).toEqual(new Date('2026-07-01T15:09:00.000Z'));
      expect(plano.logoutEm).toBeNull();
      expect(plano.clientIp).toBe('10.0.0.5');
      // Campo que não veio fica `undefined`: não sobrescreve o cadastro.
      expect(plano.camposDoAparelho).toEqual({
        brand: 'Samsung',
        model: 'SM-A155M',
        modelId: undefined,
        osName: 'Android',
        osVersion: '14',
        deviceType: undefined,
        timezone: undefined,
      });
      expect(plano.eventos).toEqual([
        {
          occurredAt: new Date('2026-07-01T15:01:00.000Z'),
          seq: 0,
          eventType: 'SCREEN',
          name: 'screen_home',
          screen: null,
          outcome: null,
          durationMs: 3000,
        },
        {
          occurredAt: new Date('2026-07-01T15:02:00.000Z'),
          seq: 1,
          eventType: 'ACTION',
          name: 'auth_login_success',
          screen: null,
          outcome: null,
          durationMs: null,
        },
        {
          occurredAt: new Date('2026-07-01T15:09:00.000Z'),
          seq: 2,
          eventType: 'ACTION',
          name: 'auth_login_success',
          screen: null,
          outcome: null,
          durationMs: null,
        },
        {
          occurredAt: new Date('2026-07-01T15:05:00.000Z'),
          seq: 3,
          eventType: 'FORM',
          name: 'form_login',
          screen: 'screen_login',
          outcome: 'success',
          durationMs: null,
        },
      ]);
    });

    it('sem bloco `device`: nenhum campo do aparelho é sobrescrito', () => {
      const plano = montarPlanoDaJornada({
        device: null,
        clientIp: null,
        events: [],
      });

      expect(Object.values(plano.camposDoAparelho)).toEqual(
        Array(7).fill(undefined),
      );
      expect(plano.eventos).toEqual([]);
    });
  });

  describe('montarPlanoDeIngestao', () => {
    it('chave do dia, recibo e linhas a partir do payload do job', () => {
      const plano = montarPlanoDeIngestao(dados());

      expect(plano.chave).toEqual({
        dia: new Date('2026-07-01T00:00:00.000Z'),
        plataforma: 'android',
        appVersion: '2.1.0',
      });
      expect(plano.recibo).toEqual({
        periodStart: new Date('2026-07-01T15:00:00.000Z'),
        periodEnd: new Date('2026-07-01T15:30:00.000Z'),
        platform: 'android',
        appVersion: '2.1.0',
        runtimeVersion: '49.0.0',
        installHash: 'i'.repeat(64),
        sessionHash: 's'.repeat(64),
        acceptedScreensCount: 1,
        acceptedActionsCount: 1,
        acceptedFormsCount: 0,
        discardedItemsCount: 0,
        validationStatus: 'ACCEPTED',
        payloadHash: 'p'.repeat(64),
        analyticsUserId: null,
        journeyEventsCount: 0,
      });
      expect(plano.telas).toEqual([
        { screen: 'screen_home', viewCount: 2, totalTimeMs: 5000 },
      ]);
      expect(plano.acoes).toEqual([{ action: 'auth_login_success', count: 1 }]);
      expect(plano.formularios).toEqual([]);
      expect(plano.jornada).toBeNull();
    });

    it('o dia é o de São Paulo: 02h30 UTC ainda é a véspera', () => {
      const plano = montarPlanoDeIngestao(
        dados({
          sanitizedPayload: {
            ...dados().sanitizedPayload,
            period_start: '2026-07-02T02:30:00.000Z',
            period_end: '2026-07-02T03:00:00.000Z',
          },
        }),
      );

      expect(plano.chave.dia).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    });

    it('houve descarte: o recibo sai PARTIAL', () => {
      expect(
        montarPlanoDeIngestao(dados({ discardedItemsCount: 3 })).recibo,
      ).toMatchObject({ validationStatus: 'PARTIAL', discardedItemsCount: 3 });
    });

    it('versão do app é aparada e cortada em 20 caracteres; sem runtime, fica indefinido', () => {
      const base = dados().sanitizedPayload;
      const plano = montarPlanoDeIngestao(
        dados({
          sanitizedPayload: {
            ...base,
            app_version: `  ${'9'.repeat(30)}  `,
            runtime_version: undefined,
          },
        }),
      );

      expect(plano.chave.appVersion).toBe('9'.repeat(20));
      expect(plano.recibo.appVersion).toBe('9'.repeat(20));
      expect(plano.runtimeVersion).toBeUndefined();
    });

    it('com jornada e conta: o recibo conta os eventos e o plano leva o usuário', () => {
      const plano = montarPlanoDeIngestao(
        dados({
          analyticsUserId: 77,
          journey: {
            device: null,
            clientIp: null,
            events: [
              evento({
                t: '2026-07-01T15:01:00.000Z',
                type: 'action',
                event: 'auth_logout',
              }),
            ],
          },
        }),
      );

      expect(plano.analyticsUserId).toBe(77);
      expect(plano.recibo).toMatchObject({
        analyticsUserId: 77,
        journeyEventsCount: 1,
      });
      expect(plano.jornada?.logoutEm).toEqual(
        new Date('2026-07-01T15:01:00.000Z'),
      );
    });

    it('`analyticsUserId` ausente no job (job antigo) vira null', () => {
      const { analyticsUserId: _fora, ...semUsuario } = dados();

      expect(montarPlanoDeIngestao(semUsuario).analyticsUserId).toBeNull();
    });
  });
});

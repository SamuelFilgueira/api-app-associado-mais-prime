import { Test, TestingModule } from '@nestjs/testing';
import {
  UnprocessableEntityException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AnalyticsService } from 'src/analytics/services/analytics.service';
import { PrismaService } from 'src/database/prisma.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { ANALYTICS_QUEUE } from 'src/queue/queue.module';
import { LimitadorService } from 'src/infra/rate-limit/limitador.service';

const VALID_PAYLOAD = {
  period_start: '2024-01-01T00:00:00Z',
  period_end: '2024-01-01T00:30:00Z',
  app: { platform: 'android', version: '1.0.0' },
  session: {
    session_id: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
    anonymous_install_id: 'b2c3d4e5-f6a7-4890-bcde-f01234567890',
  },
  screens: [{ screen: 'screen_home', view_count: 2, total_time_ms: 5000 }],
  actions: [{ action: 'auth_login_success', count: 1 }],
  forms: [],
};

const mockProdutor = {
  enfileirar: jest.fn().mockResolvedValue({ id: 'job-1' }),
};

const mockLimitador = {
  consumir: jest.fn().mockResolvedValue({ total: 1, restanteMs: 60_000 }),
  avisarRedisFora: jest.fn(),
};

const mockPrisma: { $queryRaw: jest.Mock } = {
  $queryRaw: jest.fn(),
};

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    process.env.ANALYTICS_SECRET = 'test-secret-1234567890abcdef1234567890ab';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ProdutorDeFilas, useValue: mockProdutor },
        { provide: LimitadorService, useValue: mockLimitador },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);

    jest.clearAllMocks();
    mockProdutor.enfileirar.mockResolvedValue({ id: 'job-1' });
    mockLimitador.consumir.mockResolvedValue({ total: 1, restanteMs: 60_000 });
  });

  // ─── INGESTÃO ───────────────────────────────────────────────────────────────

  describe('ingest()', () => {
    it('retorna { message: "accepted" } para payload válido sem JWT', async () => {
      const result = await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      expect(result).toEqual({ message: 'accepted' });
    });

    it('lança 422 quando payload é undefined', async () => {
      await expect(
        service.ingest(undefined, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('enfileira job com payload sanitizado', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      expect(mockProdutor.enfileirar).toHaveBeenCalledTimes(1);
      expect(mockProdutor.enfileirar).toHaveBeenCalledWith(
        ANALYTICS_QUEUE,
        'process-summary',
        expect.objectContaining({
          payloadHash: expect.any(String),
          installHash: expect.any(String),
          sessionHash: expect.any(String),
        }),
        // Summary anônimo: sem base. Retry e retenção são os da fila; o
        // `jobId` é o `payloadHash` (barra o reenvio já na entrada).
        { jobId: expect.stringMatching(/^[0-9a-f]{64}$/) },
      );
    });

    it('o `jobId` do job é o `payloadHash` do summary sanitizado', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);

      const [, , dados, opcoes] = mockProdutor.enfileirar.mock.calls[0];
      expect(opcoes).toEqual({ jobId: dados.payloadHash });
    });

    it('o mesmo summary reenviado (retry de rede do app) sai com o mesmo `jobId`: a fila ignora o segundo', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      // O reenvio chega por outra conexão; o conteúdo é o mesmo.
      await service.ingest(
        JSON.parse(JSON.stringify(VALID_PAYLOAD)),
        '10.9.8.7',
        false,
      );

      const [primeiro, segundo] = mockProdutor.enfileirar.mock.calls;
      expect(segundo[3].jobId).toBe(primeiro[3].jobId);
    });

    it('summaries diferentes (outro período, outra sessão, outro conteúdo) têm `jobId` diferentes', async () => {
      const variantes = [
        VALID_PAYLOAD,
        { ...VALID_PAYLOAD, period_end: '2024-01-01T00:31:00Z' },
        {
          ...VALID_PAYLOAD,
          session: {
            ...VALID_PAYLOAD.session,
            session_id: 'c1b2c3d4-e5f6-4789-abcd-ef0123456789',
          },
        },
        {
          ...VALID_PAYLOAD,
          screens: [
            { screen: 'screen_home', view_count: 3, total_time_ms: 5000 },
          ],
        },
      ];

      for (const payload of variantes) {
        await service.ingest(payload, '127.0.0.1', false);
      }

      const ids = mockProdutor.enfileirar.mock.calls.map((c) => c[3].jobId);
      expect(new Set(ids).size).toBe(variantes.length);
    });

    it('o payload do job e o `payloadHash` são os mesmos de antes da extração (reenvio que atravessa o deploy ainda é reconhecido)', async () => {
      process.env.ANALYTICS_JOURNEY_ENABLED = 'true';
      process.env.ANALYTICS_LINK_USER_ENABLED = 'false';

      await service.ingest(
        {
          period_start: '2024-01-01T00:00:00Z',
          period_end: '2024-01-01T00:30:00Z',
          app: {
            platform: 'android',
            version: ' 1.0.0 ',
            runtime_version: '49.0.0',
          },
          session: VALID_PAYLOAD.session,
          screens: [
            { screen: 'screen_home', view_count: 2, total_time_ms: 5000 },
            { screen: 'screen_fora', view_count: 2, total_time_ms: 5000 },
          ],
          actions: [{ action: 'auth_login_success', count: 1 }],
          forms: [
            {
              screen: 'screen_login',
              form: 'form_login',
              started_count: 1,
              submitted_count: 1,
              success_count: 1,
              error_count: 0,
            },
          ],
          device: { brand: 'Samsung', model: 'SM-A155M' },
          journey: [
            {
              t: '2024-01-01T00:05:00Z',
              type: 'screen',
              event: 'screen_home',
              duration_ms: 3000,
            },
          ],
        },
        '10.0.0.5',
        false,
        77,
      );
      process.env.ANALYTICS_JOURNEY_ENABLED = 'false';

      // Valores capturados do código anterior à extração para `domain/`.
      const installHash =
        '3f2b94ad15d71cb1f9a9a5817bded91c1a4ed497f814f4a876dcacfe8c0bbd8d';
      const sessionHash =
        '1fb5528963c810854ff899c5746794cc36b7a08888946f31143845c1c2018552';
      expect(mockProdutor.enfileirar.mock.calls[0][2]).toEqual({
        sanitizedPayload: {
          period_start: '2024-01-01T00:00:00Z',
          period_end: '2024-01-01T00:30:00Z',
          platform: 'android',
          app_version: '1.0.0',
          runtime_version: '49.0.0',
          install_hash: installHash,
          session_hash: sessionHash,
          screens: [
            { screen: 'screen_home', view_count: 2, total_time_ms: 5000 },
          ],
          actions: [{ action: 'auth_login_success', count: 1 }],
          forms: [
            {
              screen: 'screen_login',
              form: 'form_login',
              started_count: 1,
              submitted_count: 1,
              success_count: 1,
              error_count: 0,
            },
          ],
        },
        installHash,
        sessionHash,
        payloadHash:
          '4b6a545d62ffcbd925e7c49f775b5ee8d51a9cf622d2e1b1c94574b2f934d8ff',
        discardedItemsCount: 1,
        acceptedScreensCount: 1,
        acceptedActionsCount: 1,
        acceptedFormsCount: 1,
        analyticsUserId: null,
        journey: {
          device: {
            brand: 'Samsung',
            model: 'SM-A155M',
            model_id: null,
            os_name: null,
            os_version: null,
            device_type: null,
            timezone: null,
          },
          events: [
            {
              t: '2024-01-01T00:05:00.000Z',
              type: 'screen',
              event: 'screen_home',
              duration_ms: 3000,
              screen: null,
              outcome: null,
            },
          ],
          clientIp: '10.0.0.5',
        },
      });
    });

    it('não persiste userId — payload enfileirado não tem campo userId', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(JSON.stringify(jobData)).not.toContain('userId');
      expect(JSON.stringify(jobData)).not.toContain('user_id');
    });

    it('salva analyticsUserId quando flag está true e JWT userId numérico é enviado', async () => {
      process.env.ANALYTICS_LINK_USER_ENABLED = 'true';
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false, 123);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.analyticsUserId).toBe(123);
    });

    it('salva analyticsUserId quando JWT userId vem como string numérica', async () => {
      process.env.ANALYTICS_LINK_USER_ENABLED = 'true';
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false, '456');
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.analyticsUserId).toBe(456);
    });

    it('mantém analyticsUserId null quando flag está false', async () => {
      process.env.ANALYTICS_LINK_USER_ENABLED = 'false';
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false, 999);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.analyticsUserId).toBeNull();
    });

    it('mantém analyticsUserId null quando JWT userId é inválido', async () => {
      process.env.ANALYTICS_LINK_USER_ENABLED = 'true';
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false, 'abc');
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.analyticsUserId).toBeNull();
    });

    it('não persiste session_id bruto — apenas sessionHash', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(JSON.stringify(jobData)).not.toContain(
        VALID_PAYLOAD.session.session_id,
      );
      expect(jobData.sessionHash).toBeDefined();
      expect(jobData.sessionHash).toHaveLength(64);
    });

    it('não persiste anonymous_install_id bruto — apenas installHash', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(JSON.stringify(jobData)).not.toContain(
        VALID_PAYLOAD.session.anonymous_install_id,
      );
      expect(jobData.installHash).toBeDefined();
      expect(jobData.installHash).toHaveLength(64);
    });

    it('lança 422 se period_start é inválido', async () => {
      const payload = { ...VALID_PAYLOAD, period_start: 'not-a-date' };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se period_end <= period_start', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        period_start: '2024-01-01T01:00:00Z',
        period_end: '2024-01-01T00:00:00Z',
      };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se janela de período > 1 hora', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        period_start: '2024-01-01T00:00:00Z',
        period_end: '2024-01-01T02:00:00Z',
      };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se payload contém propriedade proibida (cpf)', async () => {
      const payload = { ...VALID_PAYLOAD, cpf: '000.000.000-00' };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se payload contém userId', async () => {
      const payload = { ...VALID_PAYLOAD, userId: 123 };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se app.platform é inválida', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        app: { ...VALID_PAYLOAD.app, platform: 'windows' },
      };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se session_id não é UUID v4', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        session: { ...VALID_PAYLOAD.session, session_id: 'not-a-uuid' },
      };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se anonymous_install_id não é UUID v4', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        session: {
          ...VALID_PAYLOAD.session,
          anonymous_install_id: 'not-a-uuid',
        },
      };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se payload excede o tamanho máximo (64KB)', async () => {
      const bigScreen = Array.from({ length: 10000 }, (_, i) => ({
        screen: `screen_home_${i}`,
        view_count: 1,
        total_time_ms: 1000,
      }));
      const payload = { ...VALID_PAYLOAD, screens: bigScreen };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('descarta screen fora da allowlist sem rejeitar o payload', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        screens: [
          { screen: 'screen_home', view_count: 1, total_time_ms: 1000 },
          { screen: 'screen_nao_existe', view_count: 1, total_time_ms: 500 },
        ],
      };
      const result = await service.ingest(payload, '127.0.0.1', false);
      expect(result).toEqual({ message: 'accepted' });

      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.discardedItemsCount).toBe(1);
      expect(jobData.acceptedScreensCount).toBe(1);
    });

    it('descarta action fora da allowlist sem rejeitar o payload', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        actions: [
          { action: 'auth_login_success', count: 1 },
          { action: 'action_nao_existe', count: 1 },
        ],
      };
      const result = await service.ingest(payload, '127.0.0.1', false);
      expect(result).toEqual({ message: 'accepted' });

      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.discardedItemsCount).toBe(1);
      expect(jobData.acceptedActionsCount).toBe(1);
    });

    it('descarta form fora da allowlist sem rejeitar o payload', async () => {
      const payload = {
        ...VALID_PAYLOAD,
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
            form: 'form_nao_existe',
            started_count: 1,
            submitted_count: 0,
            success_count: 0,
            error_count: 0,
          },
        ],
      };
      const result = await service.ingest(payload, '127.0.0.1', false);
      expect(result).toEqual({ message: 'accepted' });

      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.discardedItemsCount).toBe(1);
      expect(jobData.acceptedFormsCount).toBe(1);
    });

    it('clamp view_count acima do máximo', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        screens: [
          { screen: 'screen_home', view_count: 99999, total_time_ms: 1000 },
        ],
      };
      await service.ingest(payload, '127.0.0.1', false);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      const screen = jobData.sanitizedPayload.screens[0];
      expect(screen.view_count).toBe(9999);
    });

    it('clamp total_time_ms acima do máximo', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        screens: [
          { screen: 'screen_home', view_count: 1, total_time_ms: 99999999 },
        ],
      };
      await service.ingest(payload, '127.0.0.1', false);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      const screen = jobData.sanitizedPayload.screens[0];
      expect(screen.total_time_ms).toBe(3_600_000);
    });

    // ─── Jornada (ANALYTICS_JOURNEY_ENABLED) ───
    const JOURNEY_PAYLOAD = {
      ...VALID_PAYLOAD,
      device: {
        brand: 'Samsung',
        model: 'SM-A155M',
        os_name: 'Android',
        os_version: '14',
      },
      journey: [
        {
          t: '2024-01-01T00:05:00Z',
          type: 'screen',
          event: 'screen_home',
          duration_ms: 3000,
        },
        {
          t: '2024-01-01T00:06:00Z',
          type: 'action',
          event: 'auth_login_success',
        },
        { t: '2024-01-01T00:07:00Z', type: 'screen', event: 'screen_invalida' },
      ],
    };

    it('ignora device/journey quando ANALYTICS_JOURNEY_ENABLED está false (contrato antigo intacto)', async () => {
      process.env.ANALYTICS_JOURNEY_ENABLED = 'false';
      await service.ingest(JOURNEY_PAYLOAD, '127.0.0.1', false);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.journey).toBeUndefined();
      expect(jobData.discardedItemsCount).toBe(0);
    });

    it('enfileira device e eventos aceitos quando a flag está true', async () => {
      process.env.ANALYTICS_JOURNEY_ENABLED = 'true';
      await service.ingest(JOURNEY_PAYLOAD, '10.0.0.5', false);
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.journey.device.model).toBe('SM-A155M');
      expect(jobData.journey.clientIp).toBe('10.0.0.5');
      expect(jobData.journey.events.map((e) => e.event)).toEqual([
        'screen_home',
        'auth_login_success',
      ]);
      // tela fora da allowlist conta como descarte no recibo
      expect(jobData.discardedItemsCount).toBe(1);
      // sanitizedPayload (base do payloadHash) não muda com a jornada
      expect(jobData.sanitizedPayload.journey).toBeUndefined();
      process.env.ANALYTICS_JOURNEY_ENABLED = 'false';
    });

    it('payload sem device/journey continua válido com a flag ligada', async () => {
      process.env.ANALYTICS_JOURNEY_ENABLED = 'true';
      const result = await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      expect(result).toEqual({ message: 'accepted' });
      const jobData = mockProdutor.enfileirar.mock.calls[0][2];
      expect(jobData.journey).toEqual({
        device: null,
        events: [],
        clientIp: '127.0.0.1',
      });
      process.env.ANALYTICS_JOURNEY_ENABLED = 'false';
    });

    it('lança 422 se journey usa chave proibida (name)', async () => {
      process.env.ANALYTICS_JOURNEY_ENABLED = 'true';
      const payload = {
        ...VALID_PAYLOAD,
        journey: [
          { t: '2024-01-01T00:05:00Z', type: 'screen', name: 'screen_home' },
        ],
      };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      process.env.ANALYTICS_JOURNEY_ENABLED = 'false';
    });

    it('lança 429 quando rate limit de IP é atingido', async () => {
      // acima do RATE_LIMIT_IP_MAX=10
      mockLimitador.consumir.mockResolvedValue({
        total: 11,
        restanteMs: 30_000,
      });
      await expect(
        service.ingest(VALID_PAYLOAD, '127.0.0.1', true),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });

    it('Redis fora: a telemetria passa sem limite em vez de responder 500', async () => {
      mockLimitador.consumir.mockRejectedValue(
        new Error('Connection is closed.'),
      );
      await expect(
        service.ingest(VALID_PAYLOAD, '127.0.0.1', true),
      ).resolves.toEqual({ message: 'accepted' });
      expect(mockLimitador.avisarRedisFora).toHaveBeenCalled();
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import {
  UnprocessableEntityException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../prisma.service';
import { ANALYTICS_QUEUE } from '../queue/queue.module';
import { ANALYTICS_REDIS } from './analytics-redis.provider';

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

const mockQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

const mockRedis = {
  incr: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
};

const mockPrisma = {};

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    process.env.ANALYTICS_SECRET = 'test-secret-1234567890abcdef1234567890ab';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken(ANALYTICS_QUEUE), useValue: mockQueue },
        { provide: ANALYTICS_REDIS, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);

    jest.clearAllMocks();
    mockQueue.add.mockResolvedValue({ id: 'job-1' });
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
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
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-summary',
        expect.objectContaining({
          payloadHash: expect.any(String),
          installHash: expect.any(String),
          sessionHash: expect.any(String),
        }),
        expect.any(Object),
      );
    });

    it('não persiste userId — payload enfileirado não tem campo userId', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      const jobData = mockQueue.add.mock.calls[0][1];
      expect(JSON.stringify(jobData)).not.toContain('userId');
      expect(JSON.stringify(jobData)).not.toContain('user_id');
    });

    it('salva analyticsUserId quando flag está true e JWT userId numérico é enviado', async () => {
      process.env.ANALYTICS_LINK_USER_ENABLED = 'true';
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false, 123);
      const jobData = mockQueue.add.mock.calls[0][1];
      expect(jobData.analyticsUserId).toBe(123);
    });

    it('salva analyticsUserId quando JWT userId vem como string numérica', async () => {
      process.env.ANALYTICS_LINK_USER_ENABLED = 'true';
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false, '456');
      const jobData = mockQueue.add.mock.calls[0][1];
      expect(jobData.analyticsUserId).toBe(456);
    });

    it('mantém analyticsUserId null quando flag está false', async () => {
      process.env.ANALYTICS_LINK_USER_ENABLED = 'false';
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false, 999);
      const jobData = mockQueue.add.mock.calls[0][1];
      expect(jobData.analyticsUserId).toBeNull();
    });

    it('mantém analyticsUserId null quando JWT userId é inválido', async () => {
      process.env.ANALYTICS_LINK_USER_ENABLED = 'true';
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false, 'abc');
      const jobData = mockQueue.add.mock.calls[0][1];
      expect(jobData.analyticsUserId).toBeNull();
    });

    it('não persiste session_id bruto — apenas sessionHash', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      const jobData = mockQueue.add.mock.calls[0][1];
      expect(JSON.stringify(jobData)).not.toContain(
        VALID_PAYLOAD.session.session_id,
      );
      expect(jobData.sessionHash).toBeDefined();
      expect(jobData.sessionHash).toHaveLength(64);
    });

    it('não persiste anonymous_install_id bruto — apenas installHash', async () => {
      await service.ingest(VALID_PAYLOAD, '127.0.0.1', false);
      const jobData = mockQueue.add.mock.calls[0][1];
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
        session: { ...VALID_PAYLOAD.session, anonymous_install_id: 'not-a-uuid' },
      };
      await expect(
        service.ingest(payload, '127.0.0.1', false),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('lança 422 se payload excede 32KB', async () => {
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

      const jobData = mockQueue.add.mock.calls[0][1];
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

      const jobData = mockQueue.add.mock.calls[0][1];
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

      const jobData = mockQueue.add.mock.calls[0][1];
      expect(jobData.discardedItemsCount).toBe(1);
      expect(jobData.acceptedFormsCount).toBe(1);
    });

    it('clamp view_count acima do máximo', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        screens: [{ screen: 'screen_home', view_count: 99999, total_time_ms: 1000 }],
      };
      await service.ingest(payload, '127.0.0.1', false);
      const jobData = mockQueue.add.mock.calls[0][1];
      const screen = jobData.sanitizedPayload.screens[0];
      expect(screen.view_count).toBe(9999);
    });

    it('clamp total_time_ms acima do máximo', async () => {
      const payload = {
        ...VALID_PAYLOAD,
        screens: [{ screen: 'screen_home', view_count: 1, total_time_ms: 99999999 }],
      };
      await service.ingest(payload, '127.0.0.1', false);
      const jobData = mockQueue.add.mock.calls[0][1];
      const screen = jobData.sanitizedPayload.screens[0];
      expect(screen.total_time_ms).toBe(3_600_000);
    });

    it('lança 429 quando rate limit de IP é atingido', async () => {
      mockRedis.incr.mockResolvedValue(11); // acima do RATE_LIMIT_IP_MAX=10
      await expect(
        service.ingest(VALID_PAYLOAD, '127.0.0.1', true),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });
  });
});

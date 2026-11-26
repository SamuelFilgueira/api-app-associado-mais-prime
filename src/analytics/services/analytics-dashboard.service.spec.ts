import { UnprocessableEntityException } from '@nestjs/common';
import { AnalyticsDashboardRepository } from 'src/analytics/repositories/analytics-dashboard.repository';
import { AnalyticsDashboardService } from 'src/analytics/services/analytics-dashboard.service';
import { PrismaService } from 'src/database/prisma.service';

/**
 * Caracterização dos dashboards (`GET /analytics/dashboard/*`): o que cada
 * consulta lê e o formato exato do que devolve.
 */
describe('Dashboards de analytics', () => {
  const prisma = {
    analyticsSessionDaily: { aggregate: jest.fn(), findMany: jest.fn() },
    analyticsActionDaily: { findMany: jest.fn() },
    analyticsScreenDaily: { findMany: jest.fn() },
    analyticsFormDaily: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  let service: AnalyticsDashboardService;

  const PERIODO = { from: '2026-07-01', to: '2026-07-31' };
  const filtroDoPeriodo = {
    day: { gte: new Date('2026-07-01'), lte: new Date('2026-07-31') },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AnalyticsDashboardService(
      new AnalyticsDashboardRepository(prisma as unknown as PrismaService),
    );
  });

  describe('overview', () => {
    beforeEach(() => {
      prisma.analyticsSessionDaily.aggregate.mockResolvedValue({
        _sum: { sessionsCount: 40, installsCount: 12 },
      });
      prisma.analyticsActionDaily.findMany.mockResolvedValue([
        { action: 'auth_login_success', count: 5 },
        { action: 'auth_login_success', count: 7 },
        { action: 'auth_login_error', count: 2 },
        { action: 'sos_phone_triggered', count: 1 },
        { action: 'boleto_copied', count: 30 },
      ]);
      prisma.analyticsScreenDaily.findMany.mockResolvedValue([
        { screen: 'screen_home', viewCount: 10, totalTimeMs: 1000 },
        { screen: 'screen_home', viewCount: 5, totalTimeMs: 500 },
        { screen: 'screen_login', viewCount: 20, totalTimeMs: 100 },
        { screen: 'screen_perfil', viewCount: 0, totalTimeMs: 0 },
      ]);
    });

    it('soma as linhas diárias do período e devolve os totais e os rankings', async () => {
      await expect(service.getDashboardOverview(PERIODO)).resolves.toEqual({
        totalSessions: 40,
        totalInstalls: 12,
        totalLoginSuccess: 12,
        totalLoginError: 2,
        totalLogout: 0,
        totalBiometricSuccess: 0,
        totalBiometricError: 0,
        totalCouponRedeemSuccess: 0,
        totalCouponRedeemError: 0,
        totalInspectionStarted: 0,
        totalInspectionSubmitted: 0,
        totalInspectionError: 0,
        totalSosPhoneTriggered: 1,
        totalSosWhatsappTriggered: 0,
        topScreens: [
          {
            screen: 'screen_login',
            viewCount: 20,
            totalTimeMs: 100,
            avgTimeMs: 5,
          },
          {
            screen: 'screen_home',
            viewCount: 15,
            totalTimeMs: 1500,
            avgTimeMs: 100,
          },
          {
            screen: 'screen_perfil',
            viewCount: 0,
            totalTimeMs: 0,
            avgTimeMs: 0,
          },
        ],
        topActions: [
          { action: 'boleto_copied', count: 30 },
          { action: 'auth_login_success', count: 12 },
          { action: 'auth_login_error', count: 2 },
          { action: 'sos_phone_triggered', count: 1 },
        ],
      });
    });

    it('filtra por período, plataforma e versão nas três leituras', async () => {
      await service.getDashboardOverview({
        ...PERIODO,
        platform: 'ios',
        app_version: '2.1.0',
      });

      const where = {
        ...filtroDoPeriodo,
        platform: 'ios',
        appVersion: '2.1.0',
      };
      expect(prisma.analyticsSessionDaily.aggregate).toHaveBeenCalledWith({
        where,
        _sum: { sessionsCount: true, installsCount: true },
      });
      expect(prisma.analyticsActionDaily.findMany).toHaveBeenCalledWith({
        where,
        select: { action: true, count: true },
      });
      expect(prisma.analyticsScreenDaily.findMany).toHaveBeenCalledWith({
        where,
        select: { screen: true, viewCount: true, totalTimeMs: true },
      });
    });

    it('período sem dados: zeros e rankings vazios', async () => {
      prisma.analyticsSessionDaily.aggregate.mockResolvedValue({
        _sum: { sessionsCount: null, installsCount: null },
      });
      prisma.analyticsActionDaily.findMany.mockResolvedValue([]);
      prisma.analyticsScreenDaily.findMany.mockResolvedValue([]);

      const resposta = await service.getDashboardOverview(PERIODO);

      expect(resposta.totalSessions).toBe(0);
      expect(resposta.totalInstalls).toBe(0);
      expect(resposta.topScreens).toEqual([]);
      expect(resposta.topActions).toEqual([]);
    });

    it('os rankings têm no máximo 10 itens, cortados depois da soma', async () => {
      prisma.analyticsScreenDaily.findMany.mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => ({
          screen: `screen_${i}`,
          viewCount: i + 1,
          totalTimeMs: 10,
        })),
      );
      prisma.analyticsActionDaily.findMany.mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => ({
          action: `action_${i}`,
          count: i + 1,
        })),
      );

      const resposta = await service.getDashboardOverview(PERIODO);

      expect(resposta.topScreens).toHaveLength(10);
      expect(resposta.topScreens[0].screen).toBe('screen_11');
      expect(resposta.topActions).toHaveLength(10);
      expect(resposta.topActions[0]).toEqual({
        action: 'action_11',
        count: 12,
      });
    });
  });

  it('screens: ranking completo por visualizações, com o tempo médio', async () => {
    prisma.analyticsScreenDaily.findMany.mockResolvedValue([
      { screen: 'screen_home', viewCount: 3, totalTimeMs: 100 },
      { screen: 'screen_login', viewCount: 9, totalTimeMs: 90 },
      { screen: 'screen_home', viewCount: 1, totalTimeMs: 101 },
    ]);

    await expect(service.getDashboardScreens(PERIODO)).resolves.toEqual([
      { screen: 'screen_login', viewCount: 9, totalTimeMs: 90, avgTimeMs: 10 },
      { screen: 'screen_home', viewCount: 4, totalTimeMs: 201, avgTimeMs: 50 },
    ]);
    expect(prisma.analyticsScreenDaily.findMany).toHaveBeenCalledWith({
      where: filtroDoPeriodo,
      select: { screen: true, viewCount: true, totalTimeMs: true },
    });
  });

  it('actions: soma por ação, da mais frequente para a menos', async () => {
    prisma.analyticsActionDaily.findMany.mockResolvedValue([
      { action: 'auth_logout', count: 1 },
      { action: 'boleto_copied', count: 4 },
      { action: 'auth_logout', count: 2 },
    ]);

    await expect(service.getDashboardActions(PERIODO)).resolves.toEqual([
      { action: 'boleto_copied', count: 4 },
      { action: 'auth_logout', count: 3 },
    ]);
    expect(prisma.analyticsActionDaily.findMany).toHaveBeenCalledWith({
      where: filtroDoPeriodo,
      select: { action: true, count: true },
    });
  });

  it('forms: soma por tela+formulário e calcula as taxas sobre os envios', async () => {
    prisma.analyticsFormDaily.findMany.mockResolvedValue([
      {
        screen: 'screen_login',
        form: 'form_login',
        startedCount: 10,
        submittedCount: 2,
        successCount: 1,
        errorCount: 1,
      },
      {
        screen: 'screen_login',
        form: 'form_login',
        startedCount: 5,
        submittedCount: 1,
        successCount: 1,
        errorCount: 0,
      },
      {
        screen: 'screen_trocar_senha',
        form: 'form_trocar_senha',
        startedCount: 4,
        submittedCount: 0,
        successCount: 0,
        errorCount: 0,
      },
    ]);

    await expect(service.getDashboardForms(PERIODO)).resolves.toEqual([
      {
        screen: 'screen_login',
        form: 'form_login',
        startedCount: 15,
        submittedCount: 3,
        successCount: 2,
        errorCount: 1,
        successRate: 66.67,
        errorRate: 33.33,
      },
      {
        screen: 'screen_trocar_senha',
        form: 'form_trocar_senha',
        startedCount: 4,
        submittedCount: 0,
        successCount: 0,
        errorCount: 0,
        successRate: 0,
        errorRate: 0,
      },
    ]);
  });

  it('sessions: série diária em ordem, com o dia em AAAA-MM-DD', async () => {
    prisma.analyticsSessionDaily.findMany.mockResolvedValue([
      {
        day: new Date('2026-07-01T00:00:00.000Z'),
        platform: 'android',
        appVersion: '2.0.0',
        sessionsCount: 8,
        installsCount: 3,
      },
    ]);

    await expect(service.getDashboardSessions(PERIODO)).resolves.toEqual([
      {
        day: '2026-07-01',
        platform: 'android',
        appVersion: '2.0.0',
        sessionsCount: 8,
        installsCount: 3,
      },
    ]);
    expect(prisma.analyticsSessionDaily.findMany).toHaveBeenCalledWith({
      where: filtroDoPeriodo,
      orderBy: { day: 'asc' },
      select: {
        day: true,
        platform: true,
        appVersion: true,
        sessionsCount: true,
        installsCount: true,
      },
    });
  });

  describe('intervalo de consulta', () => {
    it('sem `from`: os 30 dias que terminam em `to`', async () => {
      prisma.analyticsActionDaily.findMany.mockResolvedValue([]);

      await service.getDashboardActions({ to: '2026-07-31' });

      expect(prisma.analyticsActionDaily.findMany).toHaveBeenCalledWith({
        where: {
          day: { gte: new Date('2026-07-01'), lte: new Date('2026-07-31') },
        },
        select: { action: true, count: true },
      });
    });

    it('`from` depois de `to`: 422', async () => {
      await expect(
        service.getDashboardScreens({ from: '2026-08-01', to: '2026-07-01' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('mais de 12 meses: 422', async () => {
      await expect(
        service.getDashboardForms({ from: '2025-01-01', to: '2026-07-01' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  // ─── DASHBOARD: AUDIÊNCIA ───────────────────────────────────────────────────

  describe('getDashboardAudience()', () => {
    // O Promise.all do serviço dispara as queries nesta ordem:
    // aparelhos, sessões, novos aparelhos, série diária de novos.
    const queueAudienceRows = (rows: {
      devices?: unknown[];
      sessions?: unknown[];
      news?: unknown[];
      newsDaily?: unknown[];
    }) => {
      prisma.$queryRaw
        .mockResolvedValueOnce(rows.devices ?? [])
        .mockResolvedValueOnce(rows.sessions ?? [])
        .mockResolvedValueOnce(rows.news ?? [])
        .mockResolvedValueOnce(rows.newsDaily ?? []);
    };

    it('converte BigInt do MySQL e agrega totais por plataforma', async () => {
      queueAudienceRows({
        devices: [
          {
            platform: 'android',
            uniqueDevices: 1716n,
            deviceDays: 4423n,
            wau: 900n,
            mau: 1716n,
          },
          {
            platform: 'ios',
            uniqueDevices: 1411n,
            deviceDays: 4290n,
            wau: 820n,
            mau: 1411n,
          },
        ],
        sessions: [
          { platform: 'android', uniqueSessions: 8568n },
          { platform: 'ios', uniqueSessions: 10244n },
        ],
        news: [
          { platform: 'android', newDevices: 210n },
          { platform: 'ios', newDevices: 145n },
        ],
        newsDaily: [
          {
            day: new Date('2026-07-01T00:00:00.000Z'),
            platform: 'android',
            count: 7n,
          },
        ],
      });

      const result = await service.getDashboardAudience({
        from: '2026-06-29',
        to: '2026-07-28',
      });

      expect(result.days).toBe(30);
      expect(result.totals.uniqueDevices).toBe(3127);
      expect(result.totals.uniqueSessions).toBe(18812);
      expect(result.totals.newDevices).toBe(355);
      expect(result.totals.mau).toBe(3127);
      // DAU médio = (4423+4290)/30; stickiness = DAU/MAU*100
      expect(result.totals.avgDailyDevices).toBeCloseTo(290.43, 1);
      expect(result.totals.stickiness).toBeCloseTo(9.29, 1);

      // Ordenado por aparelhos únicos — android primeiro, mesmo com menos sessões
      expect(result.platforms[0].platform).toBe('android');
      expect(result.platforms[0].uniqueDevices).toBe(1716);
      expect(result.platforms[0].sessionsPerDevice).toBeCloseTo(4.99, 1);
      expect(result.platforms[1].sessionsPerDevice).toBeCloseTo(7.26, 1);

      expect(result.newDevicesDaily).toEqual([
        { day: '2026-07-01', platform: 'android', count: 7 },
      ]);
    });

    it('retorna zeros para período sem dados', async () => {
      queueAudienceRows({});
      const result = await service.getDashboardAudience({
        from: '2026-06-01',
        to: '2026-06-30',
      });
      expect(result.totals).toEqual({
        uniqueDevices: 0,
        uniqueSessions: 0,
        deviceDays: 0,
        newDevices: 0,
        avgDailyDevices: 0,
        wau: 0,
        mau: 0,
        stickiness: 0,
      });
      expect(result.platforms).toEqual([]);
    });

    it('rejeita from > to como as demais consultas de dashboard', async () => {
      await expect(
        service.getDashboardAudience({ from: '2026-07-28', to: '2026-06-01' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});

import {
  Injectable,
  Logger,
  UnprocessableEntityException,
  InternalServerErrorException,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma.service';
import { CreateAnalyticsSummaryDto } from './dto/create-analytics-summary.dto';
import { AnalyticsDashboardQueryDto } from './dto/analytics-dashboard-query.dto';
import { scanForProhibitedKeys } from './utils/prohibited-key-scanner.util';
import { hmacSha256, sha256 } from './utils/analytics-hash.util';
import {
  ALLOWED_SCREENS,
  ALLOWED_ACTIONS,
  ALLOWED_FORMS,
  MAX_PAYLOAD_BYTES,
  MAX_PERIOD_MS,
} from './constants/analytics-allowlists';
import {
  clampInt,
  sanitizeVersionString,
  CLAMP,
} from './utils/analytics-sanitizer.util';
import { ANALYTICS_QUEUE } from '../queue/queue.module';
import { ANALYTICS_REDIS } from './analytics-redis.provider';

const RATE_LIMIT_IP_WINDOW_SEC = 60;
const RATE_LIMIT_IP_MAX = 10;
const RATE_LIMIT_INSTALL_WINDOW_SEC = 3600;
const RATE_LIMIT_INSTALL_MAX = 20;

function isTruthyEnv(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

function normalizeJwtUserId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ANALYTICS_QUEUE) private readonly analyticsQueue: Queue,
    @Inject(ANALYTICS_REDIS) private readonly redis: Redis,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // INGESTÃO
  // ─────────────────────────────────────────────────────────────────────────

  async ingest(
    rawBody: unknown,
    clientIp: string,
    rateLimitEnabled: boolean,
    jwtUserId?: unknown,
  ): Promise<{ message: string }> {
    // 1. Verificar tamanho do payload
    let payloadStr: string | undefined;
    try {
      payloadStr = JSON.stringify(rawBody);
    } catch {
      throw new UnprocessableEntityException('Payload inválido');
    }

    // JSON.stringify(undefined) retorna undefined (não lança exceção).
    if (typeof payloadStr !== 'string') {
      throw new UnprocessableEntityException('Payload inválido');
    }

    if (payloadStr.length > MAX_PAYLOAD_BYTES) {
      throw new UnprocessableEntityException(
        'Payload excede o tamanho máximo permitido',
      );
    }

    // 2. Rate limit por IP (proteção de infraestrutura)
    if (rateLimitEnabled) {
      await this.checkIpRateLimit(clientIp);
    }

    // 3. Varrer chaves proibidas no objeto bruto
    const prohibited = scanForProhibitedKeys(rawBody);
    if (prohibited.length > 0) {
      throw new UnprocessableEntityException(
        'Payload contém propriedades não permitidas',
      );
    }

    // 4. Validar schema via class-validator (retorna 422, não 400)
    const dto = plainToInstance(CreateAnalyticsSummaryDto, rawBody, {
      enableImplicitConversion: false,
      excludeExtraneousValues: false,
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });
    if (errors.length > 0) {
      throw new UnprocessableEntityException('Payload com schema inválido');
    }

    // 5. Validar regras de negócio de datas
    const periodStart = new Date(dto.period_start);
    const periodEnd = new Date(dto.period_end);

    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      throw new UnprocessableEntityException('Datas inválidas no payload');
    }
    if (periodEnd <= periodStart) {
      throw new UnprocessableEntityException(
        'period_end deve ser maior que period_start',
      );
    }
    if (periodEnd.getTime() - periodStart.getTime() > MAX_PERIOD_MS) {
      throw new UnprocessableEntityException('Janela de período excede 1 hora');
    }

    // 6. Gerar hashes server-side (nunca persistir UUIDs brutos)
    const analyticsSecret = process.env.ANALYTICS_SECRET!;
    const installHash = hmacSha256(
      dto.session.anonymous_install_id,
      analyticsSecret,
    );
    const sessionHash = hmacSha256(dto.session.session_id, analyticsSecret);

    // 7. Rate limit por install_hash (após validação do body)
    if (rateLimitEnabled) {
      await this.checkInstallRateLimit(installHash);
    }

    // 8. Sanitizar e filtrar pela allowlist
    const acceptedScreens = dto.screens
      .filter((s) => ALLOWED_SCREENS.has(s.screen))
      .map((s) => ({
        screen: s.screen,
        view_count: clampInt(
          s.view_count,
          CLAMP.VIEW_COUNT.min,
          CLAMP.VIEW_COUNT.max,
        ),
        total_time_ms: clampInt(
          s.total_time_ms,
          CLAMP.TOTAL_TIME_MS.min,
          CLAMP.TOTAL_TIME_MS.max,
        ),
      }));

    const acceptedActions = dto.actions
      .filter((a) => ALLOWED_ACTIONS.has(a.action))
      .map((a) => ({
        action: a.action,
        count: clampInt(
          a.count,
          CLAMP.ACTION_COUNT.min,
          CLAMP.ACTION_COUNT.max,
        ),
      }));

    const acceptedForms = (dto.forms ?? [])
      .filter((f) => ALLOWED_FORMS.has(f.form))
      .map((f) => ({
        screen: f.screen,
        form: f.form,
        started_count: clampInt(
          f.started_count,
          CLAMP.FORM_COUNT.min,
          CLAMP.FORM_COUNT.max,
        ),
        submitted_count: clampInt(
          f.submitted_count,
          CLAMP.FORM_COUNT.min,
          CLAMP.FORM_COUNT.max,
        ),
        success_count: clampInt(
          f.success_count,
          CLAMP.FORM_COUNT.min,
          CLAMP.FORM_COUNT.max,
        ),
        error_count: clampInt(
          f.error_count,
          CLAMP.FORM_COUNT.min,
          CLAMP.FORM_COUNT.max,
        ),
      }));

    const discardedItemsCount =
      dto.screens.length -
      acceptedScreens.length +
      dto.actions.length -
      acceptedActions.length +
      (dto.forms?.length ?? 0) -
      acceptedForms.length;

    // 9. Gerar payloadHash do payload sanitizado (para idempotência)
    const sanitizedPayload = {
      period_start: dto.period_start,
      period_end: dto.period_end,
      platform: dto.app.platform,
      app_version: sanitizeVersionString(dto.app.version) ?? '',
      runtime_version: sanitizeVersionString(dto.app.runtime_version),
      install_hash: installHash,
      session_hash: sessionHash,
      screens: acceptedScreens,
      actions: acceptedActions,
      forms: acceptedForms,
    };
    const payloadHash = sha256(JSON.stringify(sanitizedPayload));

    // Capturar userId apenas quando flag de ambiente controlado estiver ativa
    const linkUserEnabled = isTruthyEnv(
      process.env.ANALYTICS_LINK_USER_ENABLED,
    );
    const normalizedUserId = normalizeJwtUserId(jwtUserId);
    const analyticsUserId = linkUserEnabled ? normalizedUserId : null;

    // 10. Enfileirar para processamento assíncrono
    try {
      await this.analyticsQueue.add(
        'process-summary',
        {
          sanitizedPayload,
          installHash,
          sessionHash,
          payloadHash,
          discardedItemsCount,
          acceptedScreensCount: acceptedScreens.length,
          acceptedActionsCount: acceptedActions.length,
          acceptedFormsCount: acceptedForms.length,
          analyticsUserId,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 500 },
          removeOnFail: { age: 86400 },
        },
      );
    } catch (err) {
      this.logger.error('Falha ao enfileirar analytics summary');
      throw new InternalServerErrorException('Erro interno');
    }

    return { message: 'accepted' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RATE LIMIT
  // ─────────────────────────────────────────────────────────────────────────

  private async checkIpRateLimit(ip: string): Promise<void> {
    const key = `analytics:rl:ip:${ip}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, RATE_LIMIT_IP_WINDOW_SEC);
    }
    if (count > RATE_LIMIT_IP_MAX) {
      throw new HttpException(
        'Rate limit excedido',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async checkInstallRateLimit(installHash: string): Promise<void> {
    const key = `analytics:rl:install:${installHash}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, RATE_LIMIT_INSTALL_WINDOW_SEC);
    }
    if (count > RATE_LIMIT_INSTALL_MAX) {
      throw new HttpException(
        'Rate limit excedido',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DASHBOARD
  // ─────────────────────────────────────────────────────────────────────────

  private resolveDateRange(query: AnalyticsDashboardQueryDto): {
    from: Date;
    to: Date;
  } {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (from > to) {
      throw new UnprocessableEntityException('"from" deve ser anterior a "to"');
    }

    const diffMs = to.getTime() - from.getTime();
    const maxMs = 366 * 24 * 60 * 60 * 1000;
    if (diffMs > maxMs) {
      throw new UnprocessableEntityException(
        'Intervalo máximo de consulta é 12 meses',
      );
    }

    return { from, to };
  }

  private platformWhere(query: AnalyticsDashboardQueryDto) {
    const where: Record<string, unknown> = {};
    if (query.platform) where.platform = query.platform;
    if (query.app_version) where.appVersion = query.app_version;
    return where;
  }

  async getDashboardOverview(query: AnalyticsDashboardQueryDto) {
    const { from, to } = this.resolveDateRange(query);
    const platformWhere = this.platformWhere(query);

    const actionWhere = { day: { gte: from, lte: to }, ...platformWhere };

    const [sessionsRows, actionsRows, topScreenRows] = await Promise.all([
      this.prisma.analyticsSessionDaily.aggregate({
        where: { day: { gte: from, lte: to }, ...platformWhere },
        _sum: { sessionsCount: true, installsCount: true },
      }),
      this.prisma.analyticsActionDaily.findMany({
        where: actionWhere,
        select: { action: true, count: true },
      }),
      // Sem `take` aqui: as linhas são diárias e o corte precisa acontecer
      // DEPOIS da soma do período — um take antecipado pegava 10 linhas-dia
      // e podia omitir telas consistentemente populares do ranking.
      this.prisma.analyticsScreenDaily.findMany({
        where: { day: { gte: from, lte: to }, ...platformWhere },
        select: { screen: true, viewCount: true, totalTimeMs: true },
      }),
    ]);

    // Agrupa actions manualmente (já estão somadas por dia, precisamos somar across dias)
    const actionMap = new Map<string, number>();
    for (const row of actionsRows) {
      actionMap.set(row.action, (actionMap.get(row.action) ?? 0) + row.count);
    }

    const screenMap = new Map<
      string,
      { viewCount: number; totalTimeMs: number }
    >();
    for (const row of topScreenRows) {
      const existing = screenMap.get(row.screen) ?? {
        viewCount: 0,
        totalTimeMs: 0,
      };
      screenMap.set(row.screen, {
        viewCount: existing.viewCount + row.viewCount,
        totalTimeMs: existing.totalTimeMs + row.totalTimeMs,
      });
    }

    const topScreens = Array.from(screenMap.entries())
      .sort((a, b) => b[1].viewCount - a[1].viewCount)
      .slice(0, 10)
      .map(([screen, { viewCount, totalTimeMs }]) => ({
        screen,
        viewCount,
        totalTimeMs,
        avgTimeMs: viewCount > 0 ? Math.round(totalTimeMs / viewCount) : 0,
      }));

    const topActions = Array.from(actionMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([action, count]) => ({ action, count }));

    return {
      totalSessions: sessionsRows._sum.sessionsCount ?? 0,
      totalInstalls: sessionsRows._sum.installsCount ?? 0,
      totalLoginSuccess: actionMap.get('auth_login_success') ?? 0,
      totalLoginError: actionMap.get('auth_login_error') ?? 0,
      totalLogout: actionMap.get('auth_logout') ?? 0,
      totalBiometricSuccess: actionMap.get('auth_biometric_success') ?? 0,
      totalBiometricError: actionMap.get('auth_biometric_error') ?? 0,
      totalCouponRedeemSuccess: actionMap.get('coupon_redeem_success') ?? 0,
      totalCouponRedeemError: actionMap.get('coupon_redeem_error') ?? 0,
      totalInspectionStarted: actionMap.get('inspection_started') ?? 0,
      totalInspectionSubmitted: actionMap.get('inspection_submitted') ?? 0,
      totalInspectionError: actionMap.get('inspection_error') ?? 0,
      totalSosPhoneTriggered: actionMap.get('sos_phone_triggered') ?? 0,
      totalSosWhatsappTriggered: actionMap.get('sos_whatsapp_triggered') ?? 0,
      topScreens,
      topActions,
    };
  }

  async getDashboardScreens(query: AnalyticsDashboardQueryDto) {
    const { from, to } = this.resolveDateRange(query);
    const rows = await this.prisma.analyticsScreenDaily.findMany({
      where: { day: { gte: from, lte: to }, ...this.platformWhere(query) },
      select: { screen: true, viewCount: true, totalTimeMs: true },
    });

    const screenMap = new Map<
      string,
      { viewCount: number; totalTimeMs: number }
    >();
    for (const row of rows) {
      const existing = screenMap.get(row.screen) ?? {
        viewCount: 0,
        totalTimeMs: 0,
      };
      screenMap.set(row.screen, {
        viewCount: existing.viewCount + row.viewCount,
        totalTimeMs: existing.totalTimeMs + row.totalTimeMs,
      });
    }

    return Array.from(screenMap.entries())
      .sort((a, b) => b[1].viewCount - a[1].viewCount)
      .map(([screen, { viewCount, totalTimeMs }]) => ({
        screen,
        viewCount,
        totalTimeMs,
        avgTimeMs: viewCount > 0 ? Math.round(totalTimeMs / viewCount) : 0,
      }));
  }

  async getDashboardActions(query: AnalyticsDashboardQueryDto) {
    const { from, to } = this.resolveDateRange(query);
    const rows = await this.prisma.analyticsActionDaily.findMany({
      where: { day: { gte: from, lte: to }, ...this.platformWhere(query) },
      select: { action: true, count: true },
    });

    const actionMap = new Map<string, number>();
    for (const row of rows) {
      actionMap.set(row.action, (actionMap.get(row.action) ?? 0) + row.count);
    }

    return Array.from(actionMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([action, count]) => ({ action, count }));
  }

  async getDashboardForms(query: AnalyticsDashboardQueryDto) {
    const { from, to } = this.resolveDateRange(query);
    const rows = await this.prisma.analyticsFormDaily.findMany({
      where: { day: { gte: from, lte: to }, ...this.platformWhere(query) },
      select: {
        screen: true,
        form: true,
        startedCount: true,
        submittedCount: true,
        successCount: true,
        errorCount: true,
      },
    });

    type FormAgg = {
      startedCount: number;
      submittedCount: number;
      successCount: number;
      errorCount: number;
    };
    const formMap = new Map<string, FormAgg>();
    for (const row of rows) {
      const key = `${row.screen}::${row.form}`;
      const existing = formMap.get(key) ?? {
        startedCount: 0,
        submittedCount: 0,
        successCount: 0,
        errorCount: 0,
      };
      formMap.set(key, {
        startedCount: existing.startedCount + row.startedCount,
        submittedCount: existing.submittedCount + row.submittedCount,
        successCount: existing.successCount + row.successCount,
        errorCount: existing.errorCount + row.errorCount,
      });
    }

    return Array.from(formMap.entries()).map(([key, agg]) => {
      const [screen, form] = key.split('::');
      return {
        screen,
        form,
        ...agg,
        successRate:
          agg.submittedCount > 0
            ? Number(((agg.successCount / agg.submittedCount) * 100).toFixed(2))
            : 0,
        errorRate:
          agg.submittedCount > 0
            ? Number(((agg.errorCount / agg.submittedCount) * 100).toFixed(2))
            : 0,
      };
    });
  }

  /**
   * Métricas de audiência para o painel administrativo (Insight Hub).
   *
   * Endpoint ADITIVO: nada aqui altera os contratos existentes. Ele existe
   * porque /sessions só devolve contagens já agregadas por dia — a soma de
   * `installsCount` é "aparelho-dia", não aparelhos únicos, e a diferença
   * chega a 3× num período de 30 dias.
   *
   * Semântica de cada número:
   *  - uniqueDevices:  COUNT(DISTINCT installHash) no período — cada aparelho
   *    conta UMA vez, não importa em quantos dias apareceu.
   *  - uniqueSessions: idem para sessionHash (dedup entre dias e versões).
   *  - deviceDays:     linhas de aparelho-dia — mede frequência, não base.
   *  - newDevices:     aparelhos cuja PRIMEIRA aparição histórica cai no
   *    período (AnalyticsInstallFirstSeen) — aquisição real.
   *  - avgDailyDevices (DAU): deviceDays ÷ dias corridos do período.
   *  - wau / mau:      aparelhos únicos nos 7 / 30 dias que terminam em `to`
   *    (janelas fixas, independentes do tamanho do período consultado).
   *  - stickiness:     DAU ÷ MAU × 100 — % da base mensal que volta num dia.
   *
   * Filtro por app_version: aplicado sobre a versão registrada na PRIMEIRA
   * aparição do aparelho no dia. Aparelho que atualizou no meio do dia fica
   * na versão antiga até o dia seguinte.
   */
  async getDashboardAudience(query: AnalyticsDashboardQueryDto) {
    const { from, to } = this.resolveDateRange(query);

    // Normaliza para a granularidade de dia (a coluna é DATE ancorada em UTC).
    const dayFrom = new Date(
      from.toISOString().slice(0, 10) + 'T00:00:00.000Z',
    );
    const dayTo = new Date(to.toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const days =
      Math.floor((dayTo.getTime() - dayFrom.getTime()) / 86_400_000) + 1;

    const wauFrom = new Date(dayTo.getTime() - 6 * 86_400_000);
    const mauFrom = new Date(dayTo.getTime() - 29 * 86_400_000);

    const platformSql = query.platform
      ? Prisma.sql`AND platform = ${query.platform}`
      : Prisma.empty;
    const versionSql = query.app_version
      ? Prisma.sql`AND appVersion = ${query.app_version}`
      : Prisma.empty;

    type DeviceRow = {
      platform: string;
      uniqueDevices: bigint;
      deviceDays: bigint;
      wau: bigint;
      mau: bigint;
    };
    type SessionRow = { platform: string; uniqueSessions: bigint };
    type NewRow = { platform: string; newDevices: bigint };
    type NewDailyRow = { day: Date; platform: string; count: bigint };

    const [deviceRows, sessionRows, newRows, newDailyRows] = await Promise.all([
      this.prisma.$queryRaw<DeviceRow[]>(Prisma.sql`
        SELECT
          platform,
          COUNT(DISTINCT installHash) AS uniqueDevices,
          COUNT(*) AS deviceDays,
          COUNT(DISTINCT CASE WHEN day >= ${wauFrom} THEN installHash END) AS wau,
          COUNT(DISTINCT CASE WHEN day >= ${mauFrom} THEN installHash END) AS mau
        FROM \`AnalyticsDailyUniqueInstall\`
        WHERE day BETWEEN ${dayFrom} AND ${dayTo}
          ${platformSql} ${versionSql}
        GROUP BY platform
      `),
      this.prisma.$queryRaw<SessionRow[]>(Prisma.sql`
        SELECT platform, COUNT(DISTINCT sessionHash) AS uniqueSessions
        FROM \`AnalyticsDailyUniqueSession\`
        WHERE day BETWEEN ${dayFrom} AND ${dayTo}
          ${platformSql} ${versionSql}
        GROUP BY platform
      `),
      this.prisma.$queryRaw<NewRow[]>(Prisma.sql`
        SELECT platform, COUNT(*) AS newDevices
        FROM \`AnalyticsInstallFirstSeen\`
        WHERE firstSeenDay BETWEEN ${dayFrom} AND ${dayTo}
          ${platformSql} ${versionSql}
        GROUP BY platform
      `),
      this.prisma.$queryRaw<NewDailyRow[]>(Prisma.sql`
        SELECT firstSeenDay AS day, platform, COUNT(*) AS count
        FROM \`AnalyticsInstallFirstSeen\`
        WHERE firstSeenDay BETWEEN ${dayFrom} AND ${dayTo}
          ${platformSql} ${versionSql}
        GROUP BY firstSeenDay, platform
        ORDER BY firstSeenDay ASC
      `),
    ]);

    const sessionsByPlatform = new Map(
      sessionRows.map((r) => [r.platform, Number(r.uniqueSessions)]),
    );
    const newByPlatform = new Map(
      newRows.map((r) => [r.platform, Number(r.newDevices)]),
    );

    const platforms = deviceRows
      .map((row) => {
        const uniqueDevices = Number(row.uniqueDevices);
        const deviceDays = Number(row.deviceDays);
        const uniqueSessions = sessionsByPlatform.get(row.platform) ?? 0;
        return {
          platform: row.platform,
          uniqueDevices,
          uniqueSessions,
          deviceDays,
          newDevices: newByPlatform.get(row.platform) ?? 0,
          avgDailyDevices:
            days > 0 ? Number((deviceDays / days).toFixed(2)) : 0,
          sessionsPerDevice:
            uniqueDevices > 0
              ? Number((uniqueSessions / uniqueDevices).toFixed(2))
              : 0,
          avgActiveDaysPerDevice:
            uniqueDevices > 0
              ? Number((deviceDays / uniqueDevices).toFixed(2))
              : 0,
        };
      })
      .sort((a, b) => b.uniqueDevices - a.uniqueDevices);

    // Um installHash pertence a uma única plataforma, então a soma dos
    // distintos por plataforma É o distinto global — não há dupla contagem.
    const totals = platforms.reduce(
      (acc, p) => ({
        uniqueDevices: acc.uniqueDevices + p.uniqueDevices,
        uniqueSessions: acc.uniqueSessions + p.uniqueSessions,
        deviceDays: acc.deviceDays + p.deviceDays,
        newDevices: acc.newDevices + p.newDevices,
      }),
      { uniqueDevices: 0, uniqueSessions: 0, deviceDays: 0, newDevices: 0 },
    );

    const wau = deviceRows.reduce((acc, r) => acc + Number(r.wau), 0);
    const mau = deviceRows.reduce((acc, r) => acc + Number(r.mau), 0);
    const avgDailyDevices =
      days > 0 ? Number((totals.deviceDays / days).toFixed(2)) : 0;

    return {
      from: dayFrom.toISOString().slice(0, 10),
      to: dayTo.toISOString().slice(0, 10),
      days,
      totals: {
        ...totals,
        avgDailyDevices,
        wau,
        mau,
        stickiness:
          mau > 0 ? Number(((avgDailyDevices / mau) * 100).toFixed(2)) : 0,
      },
      platforms,
      newDevicesDaily: newDailyRows.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        platform: r.platform,
        count: Number(r.count),
      })),
    };
  }

  async getDashboardSessions(query: AnalyticsDashboardQueryDto) {
    const { from, to } = this.resolveDateRange(query);
    const rows = await this.prisma.analyticsSessionDaily.findMany({
      where: { day: { gte: from, lte: to }, ...this.platformWhere(query) },
      orderBy: { day: 'asc' },
      select: {
        day: true,
        platform: true,
        appVersion: true,
        sessionsCount: true,
        installsCount: true,
      },
    });

    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      platform: r.platform,
      appVersion: r.appVersion,
      sessionsCount: r.sessionsCount,
      installsCount: r.installsCount,
    }));
  }
}

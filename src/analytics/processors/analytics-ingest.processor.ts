import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import { ANALYTICS_QUEUE } from 'src/queue/queue.module';
import { Prisma } from '@prisma/client';
import { sanitizeVersionString } from 'src/analytics/utils/analytics-sanitizer.util';
import { saoPauloDay } from 'src/analytics/utils/analytics-day.util';
import {
  SanitizedDeviceInfo,
  SanitizedJourneyEvent,
} from 'src/analytics/utils/analytics-journey.util';
import {
  JOURNEY_CLEANUP_JOB,
  JOURNEY_DEFAULT_TTL_DAYS,
  JOURNEY_LOGIN_ACTION,
  JOURNEY_LOGOUT_ACTION,
} from 'src/analytics/constants/analytics-journey.constants';

export interface AnalyticsJourneyJobData {
  device: SanitizedDeviceInfo | null;
  events: SanitizedJourneyEvent[];
  clientIp: string | null;
}

export interface AnalyticsSummaryJobData {
  sanitizedPayload: {
    period_start: string;
    period_end: string;
    platform: string;
    app_version: string;
    runtime_version?: string;
    install_hash: string;
    session_hash: string;
    screens: Array<{
      screen: string;
      view_count: number;
      total_time_ms: number;
    }>;
    actions: Array<{ action: string; count: number }>;
    forms: Array<{
      screen: string;
      form: string;
      started_count: number;
      submitted_count: number;
      success_count: number;
      error_count: number;
    }>;
  };
  installHash: string;
  sessionHash: string;
  payloadHash: string;
  discardedItemsCount: number;
  acceptedScreensCount: number;
  acceptedActionsCount: number;
  acceptedFormsCount: number;
  /** Preenchido apenas quando ANALYTICS_LINK_USER_ENABLED=true e JWT válido presente. */
  analyticsUserId?: number | null;
  /** Presente apenas quando ANALYTICS_JOURNEY_ENABLED=true. */
  journey?: AnalyticsJourneyJobData;
}

const JOURNEY_EVENT_TYPE_MAP = {
  screen: 'SCREEN',
  action: 'ACTION',
  form: 'FORM',
} as const;

/** Lote de DELETE por execução da limpeza — evita lock longo na tabela. */
const JOURNEY_CLEANUP_BATCH = 5000;
const JOURNEY_CLEANUP_MAX_BATCHES = 200;

@Processor(ANALYTICS_QUEUE)
export class AnalyticsIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsIngestProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<AnalyticsSummaryJobData>): Promise<void> {
    if (job.name === JOURNEY_CLEANUP_JOB) {
      await this.cleanupJourney();
      return;
    }
    await this.processSummary(job);
  }

  private async processSummary(
    job: Job<AnalyticsSummaryJobData>,
  ): Promise<void> {
    const {
      sanitizedPayload,
      installHash,
      sessionHash,
      payloadHash,
      discardedItemsCount,
      acceptedScreensCount,
      acceptedActionsCount,
      acceptedFormsCount,
      analyticsUserId,
      journey,
    } = job.data;

    const {
      period_start,
      period_end,
      platform,
      app_version,
      runtime_version,
      screens,
      actions,
      forms,
    } = sanitizedPayload;

    const appVersion = sanitizeVersionString(app_version) ?? app_version;
    const runtimeVersion = sanitizeVersionString(runtime_version);
    const periodStart = new Date(period_start);
    const periodEnd = new Date(period_end);

    // Dia de negócio no fuso de São Paulo. O corte antigo (meia-noite UTC =
    // 21h em Brasília) dividia o pico noturno de uso entre dois dias.
    const day = saoPauloDay(periodStart);

    try {
      await this.prisma.$transaction(async (tx) => {
        // ── 1. Recibo técnico ──
        const receipt = await tx.analyticsSummaryReceipt.create({
          data: {
            periodStart,
            periodEnd,
            platform,
            appVersion,
            runtimeVersion,
            installHash,
            sessionHash,
            acceptedScreensCount,
            acceptedActionsCount,
            acceptedFormsCount,
            discardedItemsCount,
            validationStatus: discardedItemsCount > 0 ? 'PARTIAL' : 'ACCEPTED',
            payloadHash,
            analyticsUserId: analyticsUserId ?? null,
            journeyEventsCount: journey?.events.length ?? 0,
          },
          select: { id: true, receivedAt: true },
        });

        // ── 2. Contagem única de sessões ──
        let sessionIsNew = false;
        try {
          await tx.analyticsDailyUniqueSession.create({
            data: { day, platform, appVersion, sessionHash },
          });
          sessionIsNew = true;
        } catch {
          // unique constraint violation = sessão já contabilizada hoje
        }

        // ── 3. Contagem única de instalações ──
        // A unicidade é (day, platform, installHash) — appVersion fica gravada
        // como dimensão (a primeira vista no dia), mas não gera nova contagem.
        let installIsNew = false;
        try {
          await tx.analyticsDailyUniqueInstall.create({
            data: { day, platform, appVersion, installHash },
          });
          installIsNew = true;
        } catch {
          // unique constraint violation = instalação já contabilizada hoje
        }

        // ── 3b. Primeira aparição do aparelho (base de "instalações novas") ──
        if (installIsNew) {
          try {
            await tx.analyticsInstallFirstSeen.create({
              data: { installHash, platform, appVersion, firstSeenDay: day },
            });
          } catch {
            // unique constraint violation = aparelho já conhecido
          }
        }

        // ── 4. Upsert sessões/instalações diárias ──
        if (sessionIsNew || installIsNew) {
          await tx.analyticsSessionDaily.upsert({
            where: {
              day_platform_appVersion: {
                day,
                platform,
                appVersion,
              },
            },
            create: {
              day,
              platform,
              appVersion,
              sessionsCount: sessionIsNew ? 1 : 0,
              installsCount: installIsNew ? 1 : 0,
            },
            update: {
              sessionsCount: { increment: sessionIsNew ? 1 : 0 },
              installsCount: { increment: installIsNew ? 1 : 0 },
            },
          });
        }

        // ── 5. Upsert screens diárias ──
        for (const screen of screens) {
          await tx.analyticsScreenDaily.upsert({
            where: {
              day_platform_appVersion_screen: {
                day,
                platform,
                appVersion,
                screen: screen.screen,
              },
            },
            create: {
              day,
              platform,
              appVersion,
              screen: screen.screen,
              viewCount: screen.view_count,
              totalTimeMs: screen.total_time_ms,
            },
            update: {
              viewCount: { increment: screen.view_count },
              totalTimeMs: { increment: screen.total_time_ms },
            },
          });
        }

        // ── 6. Upsert actions diárias ──
        for (const action of actions) {
          await tx.analyticsActionDaily.upsert({
            where: {
              day_platform_appVersion_action: {
                day,
                platform,
                appVersion,
                action: action.action,
              },
            },
            create: {
              day,
              platform,
              appVersion,
              action: action.action,
              count: action.count,
            },
            update: {
              count: { increment: action.count },
            },
          });
        }

        // ── 8. Jornada (aparelho, vínculo conta↔aparelho e eventos) ──
        if (journey) {
          await this.persistJourney(tx, {
            receiptId: receipt.id,
            receivedAt: receipt.receivedAt,
            installHash,
            sessionHash,
            platform,
            appVersion,
            runtimeVersion,
            analyticsUserId: analyticsUserId ?? null,
            journey,
          });
        }

        // ── 7. Upsert forms diárias ──
        for (const form of forms) {
          await tx.analyticsFormDaily.upsert({
            where: {
              day_platform_appVersion_screen_form: {
                day,
                platform,
                appVersion,
                screen: form.screen,
                form: form.form,
              },
            },
            create: {
              day,
              platform,
              appVersion,
              screen: form.screen,
              form: form.form,
              startedCount: form.started_count,
              submittedCount: form.submitted_count,
              successCount: form.success_count,
              errorCount: form.error_count,
            },
            update: {
              startedCount: { increment: form.started_count },
              submittedCount: { increment: form.submitted_count },
              successCount: { increment: form.success_count },
              errorCount: { increment: form.error_count },
            },
          });
        }
      });
    } catch (err) {
      this.logger.error(
        `Falha ao processar analytics job ${job.id}: ${(err as Error).message}`,
      );
      throw err; // BullMQ vai retentar conforme configuração
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // JORNADA
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persiste, na mesma transação do summary:
   *  1. AnalyticsDevice (upsert por installHash) — modelo/SO/último uso/IP;
   *  2. AnalyticsUserDevice (upsert por userId+installHash) — quando há JWT;
   *  3. AnalyticsJourneyEvent (createMany) — um INSERT para todos os eventos.
   *
   * Login/logout são inferidos das ações `auth_login_success`/`auth_logout`
   * presentes na própria jornada, sem request adicional do app.
   */
  private async persistJourney(
    tx: Prisma.TransactionClient,
    ctx: {
      receiptId: number;
      receivedAt: Date;
      installHash: string;
      sessionHash: string;
      platform: string;
      appVersion: string;
      runtimeVersion?: string;
      analyticsUserId: number | null;
      journey: AnalyticsJourneyJobData;
    },
  ): Promise<void> {
    const { journey, analyticsUserId, installHash } = ctx;
    const device = journey.device;

    const loginAt = this.lastEventTime(journey.events, JOURNEY_LOGIN_ACTION);
    const logoutAt = this.lastEventTime(journey.events, JOURNEY_LOGOUT_ACTION);

    // 1. Aparelho — campos do device só sobrescrevem quando vieram no payload
    //    (undefined faz o Prisma manter o valor atual).
    const deviceFields = {
      brand: device?.brand ?? undefined,
      model: device?.model ?? undefined,
      modelId: device?.model_id ?? undefined,
      osName: device?.os_name ?? undefined,
      osVersion: device?.os_version ?? undefined,
      deviceType: device?.device_type ?? undefined,
      timezone: device?.timezone ?? undefined,
    };

    const existingDevice = await tx.analyticsDevice.upsert({
      where: { installHash },
      create: {
        installHash,
        platform: ctx.platform,
        appVersion: ctx.appVersion,
        runtimeVersion: ctx.runtimeVersion ?? null,
        lastSessionHash: ctx.sessionHash,
        lastUserId: analyticsUserId,
        lastIp: journey.clientIp,
        summariesCount: 1,
        firstSeenAt: ctx.receivedAt,
        lastSeenAt: ctx.receivedAt,
        ...deviceFields,
      },
      update: {
        platform: ctx.platform,
        appVersion: ctx.appVersion,
        runtimeVersion: ctx.runtimeVersion ?? undefined,
        lastSessionHash: ctx.sessionHash,
        // Sem JWT não se sabe quem está logado; mantém o último usuário visto.
        lastUserId: analyticsUserId ?? undefined,
        lastIp: journey.clientIp ?? undefined,
        summariesCount: { increment: 1 },
        lastSeenAt: ctx.receivedAt,
        ...deviceFields,
      },
      select: { lastUserId: true },
    });

    // 2. Vínculo conta ↔ aparelho
    if (analyticsUserId !== null) {
      await tx.analyticsUserDevice.upsert({
        where: {
          userId_installHash: { userId: analyticsUserId, installHash },
        },
        create: {
          userId: analyticsUserId,
          installHash,
          platform: ctx.platform,
          lastAppVersion: ctx.appVersion,
          lastSessionHash: ctx.sessionHash,
          summariesCount: 1,
          firstSeenAt: ctx.receivedAt,
          lastSeenAt: ctx.receivedAt,
          lastLoginAt: loginAt,
          lastLogoutAt: logoutAt,
        },
        update: {
          platform: ctx.platform,
          lastAppVersion: ctx.appVersion,
          lastSessionHash: ctx.sessionHash,
          summariesCount: { increment: 1 },
          lastSeenAt: ctx.receivedAt,
          lastLoginAt: loginAt ?? undefined,
          lastLogoutAt: logoutAt ?? undefined,
        },
      });
    } else if (logoutAt && existingDevice.lastUserId !== null) {
      // Flush pós-logout costuma chegar sem Authorization (token já apagado):
      // registra a saída no último vínculo conhecido deste aparelho.
      await tx.analyticsUserDevice.updateMany({
        where: { userId: existingDevice.lastUserId, installHash },
        data: { lastLogoutAt: logoutAt },
      });
    }

    // 3. Eventos (um único INSERT)
    if (journey.events.length > 0) {
      await tx.analyticsJourneyEvent.createMany({
        data: journey.events.map((event, seq) => ({
          occurredAt: new Date(event.t),
          receivedAt: ctx.receivedAt,
          receiptId: ctx.receiptId,
          userId: analyticsUserId,
          installHash,
          sessionHash: ctx.sessionHash,
          platform: ctx.platform,
          appVersion: ctx.appVersion,
          seq,
          eventType: JOURNEY_EVENT_TYPE_MAP[event.type],
          name: event.event,
          screen: event.screen,
          outcome: event.outcome,
          durationMs: event.duration_ms,
        })),
      });
    }
  }

  private lastEventTime(
    events: SanitizedJourneyEvent[],
    action: string,
  ): Date | null {
    let last: number | null = null;
    for (const e of events) {
      if (e.type !== 'action' || e.event !== action) continue;
      const ts = new Date(e.t).getTime();
      if (last === null || ts > last) last = ts;
    }
    return last === null ? null : new Date(last);
  }

  /**
   * Limpeza periódica: apaga eventos de jornada mais antigos que
   * ANALYTICS_JOURNEY_TTL_DAYS em lotes pequenos (LIMIT), para não segurar
   * lock na tabela. Aparelhos e vínculos não são apagados — são a memória
   * de "quais celulares já usaram a conta".
   */
  private async cleanupJourney(): Promise<void> {
    const ttlDays =
      Number.parseInt(process.env.ANALYTICS_JOURNEY_TTL_DAYS ?? '', 10) ||
      JOURNEY_DEFAULT_TTL_DAYS;
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

    let total = 0;
    for (let i = 0; i < JOURNEY_CLEANUP_MAX_BATCHES; i++) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM \`AnalyticsJourneyEvent\`
        WHERE \`occurredAt\` < ${cutoff}
        LIMIT ${JOURNEY_CLEANUP_BATCH}
      `;
      total += deleted;
      if (deleted < JOURNEY_CLEANUP_BATCH) break;
    }

    if (total > 0) {
      this.logger.log(
        `Limpeza da jornada: ${total} evento(s) anteriores a ${cutoff.toISOString()} removidos (TTL ${ttlDays}d)`,
      );
    }
  }
}

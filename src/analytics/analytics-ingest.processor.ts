import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma.service';
import { ANALYTICS_QUEUE } from '../queue/queue.module';
import { sanitizeVersionString } from './utils/analytics-sanitizer.util';

export interface AnalyticsSummaryJobData {
  sanitizedPayload: {
    period_start: string;
    period_end: string;
    platform: string;
    app_version: string;
    runtime_version?: string;
    install_hash: string;
    session_hash: string;
    screens: Array<{ screen: string; view_count: number; total_time_ms: number }>;
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
}

@Processor(ANALYTICS_QUEUE)
export class AnalyticsIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsIngestProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<AnalyticsSummaryJobData>): Promise<void> {
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

    // Determinar o dia (baseado em period_start, UTC)
    const dayStr = periodStart.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const day = new Date(dayStr + 'T00:00:00.000Z');

    try {
      await this.prisma.$transaction(async (tx) => {
        // ── 1. Recibo técnico ──
        await tx.analyticsSummaryReceipt.create({
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
          },
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
        let installIsNew = false;
        try {
          await tx.analyticsDailyUniqueInstall.create({
            data: { day, platform, appVersion, installHash },
          });
          installIsNew = true;
        } catch {
          // unique constraint violation = instalação já contabilizada hoje
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
}

import { Injectable } from '@nestjs/common';
import { AppVersionPolicy, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

interface CacheEntry {
  value: AppVersionPolicy | null;
  expiresAt: number;
}

export interface AppVersionValidationLogInput {
  requestId?: string;
  platform: 'android' | 'ios';
  appVersion?: string;
  runtimeVersion?: string;
  versionCode?: number;
  buildNumber?: number;
  policyId?: number;
  blocked: boolean;
  reason: string;
  userId?: number;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AppVersionPolicyRepository {
  private readonly cache = new Map<'android' | 'ios', CacheEntry>();
  private readonly cacheTtlMs = this.resolveNumberEnv('APP_VERSION_POLICY_CACHE_TTL_MS', 5_000);
  private readonly queryTimeoutMs = this.resolveNumberEnv('APP_VERSION_POLICY_QUERY_TIMEOUT_MS', 1_500);

  constructor(private readonly prisma: PrismaService) {}

  async getActivePolicy(platform: 'android' | 'ios'): Promise<AppVersionPolicy | null> {
    const nowMs = Date.now();
    const cached = this.cache.get(platform);
    if (cached && cached.expiresAt > nowMs) {
      return cached.value;
    }

    const now = new Date();
    const value = await this.runWithTimeout(
      this.prisma.appVersionPolicy.findFirst({
        where: {
          platform,
          isActive: true,
          effectiveFrom: { lte: now },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }],
        },
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      }),
    );

    this.cache.set(platform, {
      value,
      expiresAt: nowMs + this.cacheTtlMs,
    });

    return value;
  }

  async logValidationDecision(input: AppVersionValidationLogInput): Promise<void> {
    const data: Prisma.AppVersionValidationLogUncheckedCreateInput = {
      requestId: input.requestId,
      platform: input.platform,
      appVersion: input.appVersion,
      runtimeVersion: input.runtimeVersion,
      versionCode: input.versionCode,
      buildNumber: input.buildNumber,
      policyId: input.policyId,
      blocked: input.blocked,
      reason: input.reason,
      userId: input.userId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    };

    await this.prisma.appVersionValidationLog.create({ data });
  }

  private async runWithTimeout<T>(promise: Promise<T>): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('APP_VERSION_POLICY_QUERY_TIMEOUT'));
      }, this.queryTimeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private resolveNumberEnv(name: string, fallback: number): number {
    const raw = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(raw) || raw <= 0) {
      return fallback;
    }
    return Math.trunc(raw);
  }
}

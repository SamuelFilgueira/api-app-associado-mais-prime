import { Injectable, Logger } from '@nestjs/common';
import { AppVersionPolicy } from '@prisma/client';
import semver from 'semver';
import { ValidateAppVersionDto } from 'src/app-version/dto/validate-app-version.dto';
import { ValidateAppVersionResponseDto } from 'src/app-version/dto/validate-app-version-response.dto';
import {
  AppVersionPolicyRepository,
  AppVersionValidationLogInput,
} from 'src/app-version/repositories/app-version.repository';

interface ValidationContext {
  requestId?: string;
  userId?: number;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AppVersionService {
  private readonly logger = new Logger(AppVersionService.name);

  constructor(private readonly policyRepository: AppVersionPolicyRepository) {}

  async validateVersion(
    payload: ValidateAppVersionDto,
    context: ValidationContext = {},
  ): Promise<ValidateAppVersionResponseDto> {
    let policy: AppVersionPolicy | null = null;

    try {
      policy = await this.policyRepository.getActivePolicy(payload.platform);
    } catch (error) {
      this.logger.error(
        `Policy lookup failed for ${payload.platform}: ${(error as Error).message}`,
      );

      const fallbackResponse = this.buildAllowResponse(null);
      await this.safeLog({
        requestId: context.requestId,
        platform: payload.platform,
        appVersion: payload.appVersion,
        runtimeVersion: payload.runtimeVersion,
        versionCode: payload.versionCode,
        buildNumber: this.parseOptionalInt(payload.buildNumber),
        blocked: false,
        reason: 'policy_lookup_error',
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });

      return fallbackResponse;
    }

    if (!policy) {
      await this.safeLog({
        requestId: context.requestId,
        platform: payload.platform,
        appVersion: payload.appVersion,
        runtimeVersion: payload.runtimeVersion,
        versionCode: payload.versionCode,
        buildNumber: this.parseOptionalInt(payload.buildNumber),
        blocked: false,
        reason: 'no_active_policy',
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });

      return this.buildAllowResponse(null);
    }

    if (!policy.forceUpdateEnabled) {
      await this.safeLog({
        requestId: context.requestId,
        platform: payload.platform,
        appVersion: payload.appVersion,
        runtimeVersion: payload.runtimeVersion,
        versionCode: payload.versionCode,
        buildNumber: this.parseOptionalInt(payload.buildNumber),
        policyId: policy.id,
        blocked: false,
        reason: 'force_update_disabled',
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });

      return this.buildAllowResponse(policy);
    }

    const decision = this.evaluateBlockDecision(payload, {
      minSupportedVersion: policy.minSupportedVersion,
      minSupportedRuntimeVersion: policy.minSupportedRuntimeVersion,
      minSupportedVersionCode: policy.minSupportedVersionCode,
      minSupportedBuildNumber: policy.minSupportedBuildNumber,
    });

    await this.safeLog({
      requestId: context.requestId,
      platform: payload.platform,
      appVersion: payload.appVersion,
      runtimeVersion: payload.runtimeVersion,
      versionCode: payload.versionCode,
      buildNumber: this.parseOptionalInt(payload.buildNumber),
      policyId: policy.id,
      blocked: decision.blocked,
      reason: decision.reason,
      userId: context.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    if (!decision.blocked) {
      return this.buildAllowResponse(policy);
    }

    return {
      forceUpdate: true,
      title: policy.title,
      message: policy.message,
      storeUrl: policy.storeUrl ?? undefined,
      minSupportedVersion: policy.minSupportedVersion,
      minSupportedRuntimeVersion: policy.minSupportedRuntimeVersion ?? '',
    };
  }

  private evaluateBlockDecision(
    payload: ValidateAppVersionDto,
    policy: {
      minSupportedVersion: string;
      minSupportedRuntimeVersion?: string | null;
      minSupportedVersionCode?: number | null;
      minSupportedBuildNumber?: number | null;
    },
  ): { blocked: boolean; reason: string } {
    const appVersionResult = this.compareSemver(
      payload.appVersion,
      policy.minSupportedVersion,
      'app_version',
    );
    if (appVersionResult.blocked) {
      return appVersionResult;
    }

    if (policy.minSupportedRuntimeVersion) {
      const runtimeResult = this.compareSemver(
        payload.runtimeVersion,
        policy.minSupportedRuntimeVersion,
        'runtime_version',
      );
      if (runtimeResult.blocked) {
        return runtimeResult;
      }
    }

    if (
      payload.platform === 'android' &&
      policy.minSupportedVersionCode != null
    ) {
      if (payload.versionCode == null) {
        return { blocked: true, reason: 'missing_version_code' };
      }
      if (payload.versionCode < policy.minSupportedVersionCode) {
        return { blocked: true, reason: 'version_code_below_minimum' };
      }
    }

    if (payload.platform === 'ios' && policy.minSupportedBuildNumber != null) {
      const parsedBuildNumber = this.parseOptionalInt(payload.buildNumber);
      if (parsedBuildNumber == null) {
        return { blocked: true, reason: 'missing_or_invalid_build_number' };
      }
      if (parsedBuildNumber < policy.minSupportedBuildNumber) {
        return { blocked: true, reason: 'build_number_below_minimum' };
      }
    }

    return { blocked: false, reason: 'meets_minimum_requirements' };
  }

  private compareSemver(
    receivedVersion: string | undefined,
    minimumVersion: string,
    prefix: 'app_version' | 'runtime_version',
  ): { blocked: boolean; reason: string } {
    const minimumValid = semver.valid(minimumVersion);
    if (!minimumValid) {
      return { blocked: false, reason: `${prefix}_policy_invalid` };
    }

    if (!receivedVersion) {
      return { blocked: true, reason: `missing_${prefix}` };
    }

    const receivedValid = semver.valid(receivedVersion);
    if (!receivedValid) {
      return { blocked: true, reason: `invalid_${prefix}` };
    }

    if (semver.lt(receivedValid, minimumValid)) {
      return { blocked: true, reason: `${prefix}_below_minimum` };
    }

    return { blocked: false, reason: `${prefix}_ok` };
  }

  private parseOptionalInt(value: string | undefined): number | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }
    if (!/^\d+$/.test(value.trim())) {
      return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return parsed;
  }

  private buildAllowResponse(
    policy: {
      minSupportedVersion: string;
      minSupportedRuntimeVersion?: string | null;
    } | null,
  ): ValidateAppVersionResponseDto {
    return {
      forceUpdate: false,
      title: '',
      message: '',
      minSupportedVersion: policy?.minSupportedVersion ?? '',
      minSupportedRuntimeVersion: policy?.minSupportedRuntimeVersion ?? '',
    };
  }

  private async safeLog(input: AppVersionValidationLogInput): Promise<void> {
    try {
      await this.policyRepository.logValidationDecision(input);
    } catch (error) {
      this.logger.error(
        `Failed to write app version validation log: ${(error as Error).message}`,
      );
    }
  }
}

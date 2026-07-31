import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { AppVersionService } from 'src/app-version/services/app-version.service';
import { ValidateAppVersionDto } from 'src/app-version/dto/validate-app-version.dto';
import { ValidateAppVersionResponseDto } from 'src/app-version/dto/validate-app-version-response.dto';

@Controller('app-version')
export class AppVersionController {
  constructor(private readonly appVersionService: AppVersionService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  async validate(
    @Body() payload: ValidateAppVersionDto,
    @Req()
    req: Request & {
      user?: { userId?: number | string; sub?: number | string; id?: number | string };
    },
  ): Promise<ValidateAppVersionResponseDto> {
    return this.appVersionService.validateVersion(payload, {
      requestId: this.resolveRequestId(req),
      userId: this.resolveUserId(req.user),
      ipAddress: this.extractClientIp(req),
      userAgent: this.extractUserAgent(req),
    });
  }

  private resolveRequestId(req: Request): string {
    const requestIdHeader = req.headers['x-request-id'] ?? req.headers['x-correlation-id'];
    if (typeof requestIdHeader === 'string' && requestIdHeader.trim().length > 0) {
      return requestIdHeader.trim();
    }
    return randomUUID();
  }

  private resolveUserId(
    user:
      | { userId?: number | string; sub?: number | string; id?: number | string }
      | undefined,
  ): number | undefined {
    const value = user?.userId ?? user?.sub ?? user?.id;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return undefined;
  }

  private extractClientIp(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]?.trim();
    }

    if (Array.isArray(forwarded) && forwarded[0]) {
      return forwarded[0].split(',')[0]?.trim();
    }

    return req.socket?.remoteAddress?.replace(/^::ffff:/, '');
  }

  private extractUserAgent(req: Request): string | undefined {
    const userAgent = req.headers['user-agent'];
    if (typeof userAgent === 'string' && userAgent.trim().length > 0) {
      return userAgent;
    }
    return undefined;
  }
}

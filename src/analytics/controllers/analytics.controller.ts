import {
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AnalyticsService } from 'src/analytics/services/analytics.service';
import { OptionalJwtAuthGuard } from 'src/analytics/guards/optional-jwt-auth.guard';

@Controller('analytics')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * POST /api/analytics/summaries
   *
   * Recebe summaries agregados do app mobile.
   * Authorization é opcional — aceita requests sem JWT.
   * Nunca associa analytics ao usuário autenticado.
   */
  @Post('summaries')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(OptionalJwtAuthGuard)
  async ingestSummary(
    @Req()
    req: Request & {
      body: unknown;
      user?: { userId?: number | string; sub?: number | string; id?: number | string };
    },
  ): Promise<{ message: string }> {
    const clientIp = this.extractClientIp(req);
    const rateLimitEnabled =
      process.env.ANALYTICS_RATE_LIMIT_ENABLED !== 'false';
    const linkUserEnabled = process.env.ANALYTICS_LINK_USER_ENABLED === 'true';
    const hasAuthorizationHeader = typeof req.headers.authorization === 'string';

    // userId extraído do JWT quando presente — ignorado se flag estiver desativada
    const jwtUserId = this.resolveJwtUserId(req);

    if (linkUserEnabled && !hasAuthorizationHeader) {
      this.logger.warn(
        'Analytics request received without Authorization header while ANALYTICS_LINK_USER_ENABLED=true; analyticsUserId will be persisted as null',
      );
    }

    if (linkUserEnabled && hasAuthorizationHeader && !jwtUserId) {
      this.logger.warn(
        'Analytics received Authorization header, but JWT userId is unavailable; persisting analyticsUserId as null',
      );
    }

    return this.analyticsService.ingest(req.body, clientIp, rateLimitEnabled, jwtUserId);
  }

  private resolveJwtUserId(
    req: Request & {
      user?: { userId?: number | string; sub?: number | string; id?: number | string };
    },
  ): number | string | null {
    // Caminho principal: user já resolvido pelo AuthGuard('jwt')
    const fromGuard = req.user?.userId ?? req.user?.sub ?? req.user?.id;
    if (fromGuard !== undefined && fromGuard !== null) {
      return fromGuard;
    }

    // Fallback seguro: verificar token manualmente e extrair claims comuns de id.
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') {
      this.logger.warn('resolveJwtUserId: no Authorization header present');
      return null;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    if (!token) {
      this.logger.warn('resolveJwtUserId: Authorization header present but token could not be extracted');
      return null;
    }

    try {
      // ignoreExpiration:false garante que tokens expirados não passem.
      // audience não é especificado intencionalmente — tokens mobile são assinados
      // com audience:'mobile-app' mas a verificação de analytics não requer esse claim.
      const payload = this.jwtService.verify<Record<string, unknown>>(token, {
        secret: process.env.JWT_SECRET || 'minha_chave_secreta',
        ignoreExpiration: false,
      });

      const resolved =
        (payload.userId as number | string | undefined) ??
        (payload.sub as number | string | undefined) ??
        (payload.id as number | string | undefined) ??
        null;

      if (resolved === null || resolved === undefined) {
        this.logger.warn(
          `resolveJwtUserId: JWT verified but no userId/sub/id claim found — payload: ${JSON.stringify(payload)}`,
        );
      } else {
        this.logger.log(`resolveJwtUserId: resolved from manual verify — ${resolved}`);
      }

      return resolved ?? null;
    } catch (err: unknown) {
      this.logger.warn(`resolveJwtUserId: manual JWT verify failed — ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  private extractClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      // Pegar apenas o primeiro IP da cadeia (cliente original)
      return forwarded.split(',')[0]?.trim() ?? 'unknown';
    }
    return (req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  }
}

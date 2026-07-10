import { Injectable, ExecutionContext, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guard de JWT opcional — não rejeita requisições sem token.
 * Se um JWT válido for fornecido, popula request.user normalmente.
 * Endpoints de analytics aceitam requisições não autenticadas.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(OptionalJwtAuthGuard.name);

  handleRequest<TUser = any>(err: any, user: any, info: any, _context: ExecutionContext): TUser {
    if (err) {
      this.logger.warn(`OptionalJwtAuthGuard: authentication error — ${err?.message ?? err}`);
    } else if (!user) {
      const reason = info instanceof Error ? info.message : (info?.message ?? JSON.stringify(info));
      this.logger.warn(`OptionalJwtAuthGuard: no user resolved — info: ${reason}`);
    } else {
      this.logger.log(`OptionalJwtAuthGuard: user resolved — userId=${user?.userId ?? user?.sub ?? user?.id ?? 'unknown'}`);
    }
    return (user ?? null) as TUser;
  }
}

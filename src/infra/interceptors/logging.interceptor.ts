import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const requestId = randomUUID();
    const { method, url } = req;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse();
        const duration = Date.now() - start;
        // Identificação do chamador: userId do JWT (populado pelos guards),
        // IP e user-agent — permite distinguir app, painel e outros clientes
        const userId = req.user?.userId ?? '-';
        const ip =
          req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ??
          req.ip ??
          req.socket?.remoteAddress ??
          '-';
        const userAgent = req.headers?.['user-agent'] ?? '-';
        this.logger.log(
          `[${requestId}] ${method} ${url} ${res.statusCode} ${duration}ms | userId=${userId} | ip=${ip} | ua=${userAgent}`,
        );
      }),
    );
  }
}

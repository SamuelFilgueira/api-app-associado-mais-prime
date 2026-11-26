import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { contextoExecucao } from 'src/infra/observability/contexto-execucao';
import { rotaEmTemplate } from 'src/infra/observability/requisicao.middleware';

/**
 * Completa o contexto de execução depois que os guards rodaram: usuário,
 * base e rota em template passam a carimbar toda linha de log emitida pelo
 * handler e pelos services.
 *
 * A linha de acesso e as métricas HTTP saem do `requisicaoMiddleware`, que
 * enxerga também as requisições barradas por guard e o status final.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<{
        user?: { userId?: number | string; baseOrigin?: string };
        route?: { path?: unknown };
        baseUrl?: string;
        path: string;
      }>();
      contextoExecucao.definir({
        userId: req.user?.userId,
        base: req.user?.baseOrigin,
        rota: rotaEmTemplate(req as never),
      });
    }
    return next.handle();
  }
}

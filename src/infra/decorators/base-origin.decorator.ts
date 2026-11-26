import {
  createParamDecorator,
  ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

export interface BaseOriginOpcoes {
  /**
   * Rota que também atende token sem base (painel administrativo): devolve
   * `undefined` em vez de lançar, e o handler decide o que fazer.
   */
  opcional?: boolean;
}

interface RequisicaoComUsuario {
  user?: { baseOrigin?: string } & Record<string, unknown>;
}

const logger = new Logger('BaseOrigin');

/**
 * Lê a base resolvida pelo `JwtStrategy` em `request.user.baseOrigin`.
 * Exportada para teste; nas rotas use o decorator `@BaseOrigin()`.
 */
export function resolverBaseOrigin(
  opcoes: BaseOriginOpcoes | undefined,
  ctx: ExecutionContext,
): string | undefined {
  const request = ctx.switchToHttp().getRequest<RequisicaoComUsuario>();
  const baseOrigin = request.user?.baseOrigin;

  if (baseOrigin) return baseOrigin;
  if (opcoes?.opcional) return undefined;

  const disponivel = request.user
    ? JSON.stringify(Object.keys(request.user))
    : 'usuário não autenticado';
  logger.error(`baseOrigin não encontrado. Disponível: ${disponivel}`);
  throw new UnauthorizedException('Base de origem não configurada no token');
}

/**
 * Base de origem (tenant) da requisição, resolvida UMA vez na borda.
 *
 * - `@BaseOrigin()` falha fechado: token sem base responde 401 antes de o
 *   handler rodar — a operação nunca segue com a credencial de outra base.
 * - `@BaseOrigin({ opcional: true })` devolve `undefined` quando o token não
 *   tem base (token do painel); o parâmetro deve ser tipado como opcional.
 */
export const BaseOrigin = createParamDecorator(resolverBaseOrigin);

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  UsuarioAutenticado,
  ehTokenDoPainel,
} from 'src/infra/auth/usuario-autenticado';

/**
 * Rotas exclusivas do app do associado: recusa token emitido pelo login do
 * painel.
 *
 * App e painel assinam com o mesmo segredo, e nos dois o `sub` é um id
 * numérico — de `user` num caso, de `AdminPanelUser` no outro. Numa rota que
 * trata `userId` como id de associado, um token do painel com id 7 passaria
 * a agir como o associado 7 (ler boletos, dados do SGA, saldo...).
 *
 * Deve vir DEPOIS do `JwtAuthGuard`: `@UseGuards(JwtAuthGuard,
 * SomenteAssociadoGuard)`. O ADMIN legado do app (role ADMIN em `user`, sem
 * `adminRole`) é associado e passa normalmente.
 */
@Injectable()
export class SomenteAssociadoGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: UsuarioAutenticado }>();

    if (ehTokenDoPainel(user)) {
      throw new ForbiddenException(
        'Esta rota é exclusiva do aplicativo do associado',
      );
    }
    return true;
  }
}

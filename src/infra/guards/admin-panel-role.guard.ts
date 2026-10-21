import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ADMIN_PANEL_ROLES_KEY } from 'src/infra/decorators/admin-panel-roles.decorator';
import { AdminPanelRole } from 'src/infra/enums/admin-panel-role.enum';

/**
 * Autoriza rotas do painel administrativo.
 *
 * Regras:
 * - Sem `@AdminPanelRoles(...)` na rota/classe → libera.
 * - `role` do token precisa ser ADMIN (usuários do app comuns são barrados).
 * - Tokens do painel carregam `adminRole` (perfil do usuário do painel):
 *   `ADMIN` acessa tudo; os demais perfis só acessam rotas que listem o seu perfil.
 * - Tokens sem `adminRole` (usuário ADMIN legado do app, sem perfil de painel)
 *   continuam liberados para manter compatibilidade.
 */
@Injectable()
export class AdminPanelRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AdminPanelRole[]>(
      ADMIN_PANEL_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const tokenUser = request.user;

    if (!tokenUser?.userId) {
      throw new UnauthorizedException('Usuário não autenticado');
    }

    if (tokenUser.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Apenas usuários ADMIN podem acessar este recurso',
      );
    }

    const adminRole = tokenUser.adminRole as AdminPanelRole | undefined;

    if (!adminRole || adminRole === AdminPanelRole.ADMIN) {
      return true;
    }

    if (!requiredRoles.includes(adminRole)) {
      throw new ForbiddenException(
        'Seu perfil do painel não tem acesso a este recurso',
      );
    }

    return true;
  }
}

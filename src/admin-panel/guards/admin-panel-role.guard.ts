import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ADMIN_PANEL_ROLES_KEY } from 'src/admin-panel/decorators/admin-panel-roles.decorator';
import { AdminPanelRole } from 'src/admin-panel/enums/admin-panel-role.enum';

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

    // ADMIN tem acesso total ao painel, independentemente das roles da rota.
    return true;
  }
}

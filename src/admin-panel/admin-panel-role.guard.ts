import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  ADMIN_PANEL_ROLES_KEY,
} from './admin-panel-roles.decorator';
import { AdminPanelRole } from './admin-panel-role.enum';

@Injectable()
export class AdminPanelRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    // Tokens novos incluem adminRole no payload — sem DB query
    if (tokenUser.adminRole) {
      if (!requiredRoles.includes(tokenUser.adminRole as AdminPanelRole)) {
        throw new ForbiddenException(
          'Perfil administrativo sem permissão para esta rota',
        );
      }
      return true;
    }

    // Fallback para tokens antigos sem adminRole no payload
    let userEmail: string | undefined = tokenUser.email;

    if (!userEmail) {
      const baseUser = await this.prisma.user.findUnique({
        where: { id: tokenUser.userId },
        select: { email: true },
      });

      userEmail = baseUser?.email;
    }

    if (!userEmail) {
      throw new ForbiddenException(
        'Usuário sem e-mail para validação de perfil',
      );
    }

    const adminPanelUser = await this.prisma.adminPanelUser.findUnique({
      where: { email: userEmail },
      select: { role: true },
    });

    if (!adminPanelUser) {
      throw new ForbiddenException(
        'Usuário não cadastrado na tabela administrativa',
      );
    }

    if (!requiredRoles.includes(adminPanelUser.role as AdminPanelRole)) {
      throw new ForbiddenException(
        'Perfil administrativo sem permissão para esta rota',
      );
    }

    return true;
  }
}
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma.service';

/**
 * Guard que bloqueia acesso a rotas protegidas se o usuário ainda não trocou a senha.
 *
 * Uso:
 * @UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
 *
 * Este guard deve ser aplicado em rotas que não devem ser acessadas por usuários
 * com primeiroLogin = true (que ainda não trocaram a senha).
 *
 * A rota PATCH /associado/password NÃO deve ter este guard, pois é onde
 * o usuário vai trocar a senha.
 */
@Injectable()
export class PrimeiroLoginGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId;

    if (!userId) {
      return true; // Se não há userId, deixa o JwtAuthGuard lidar com isso
    }

    // Busca o usuário no banco para verificar o status atual de primeiroLogin
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { primeiroLogin: true },
    });

    // Se o usuário ainda não trocou a senha (primeiroLogin === true)
    // bloqueia o acesso
    if (user?.primeiroLogin === true) {
      throw new ForbiddenException({
        message:
          'É necessário trocar a senha antes de acessar outras funcionalidades',
        primeiroLogin: true,
      });
    }

    return true;
  }
}

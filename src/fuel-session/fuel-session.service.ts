import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class FuelSessionService {
  private readonly logger = new Logger(FuelSessionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retorna a FuelSession PENDING mais recente do usuário, ou null se não houver.
   */
  async findPendingForUser(userId: number) {
    return this.prisma.fuelSession.findFirst({
      where: { userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Busca uma FuelSession pelo id.
   */
  async findById(id: string) {
    return this.prisma.fuelSession.findUnique({ where: { id } });
  }

  /**
   * Cria uma nova FuelSession no estado PENDING.
   */
  async createPendingSession(userId: number, valorAntes: number) {
    const session = await this.prisma.fuelSession.create({
      data: {
        userId,
        valorAntes,
        status: 'PENDING',
      },
    });
    this.logger.log(
      `[FuelSession] Sessão ${session.id} criada para user ${userId} (valorAntes=${valorAntes})`,
    );
    return session;
  }

  /**
   * Completa a sessão: atualiza valorDepois, diferenca, status COMPLETED
   * e atualiza o totalEconomizado do usuário em uma transação atômica.
   */
  async completeSession(
    sessionId: string,
    valorDepois: number,
    diferenca: number,
    userId: number,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.fuelSession.update({
        where: { id: sessionId },
        data: {
          valorDepois,
          diferenca,
          status: 'COMPLETED',
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { totalEconomizado: valorDepois },
      }),
    ]);
    this.logger.log(
      `[FuelSession] Sessão ${sessionId} concluída para user ${userId}: +R$ ${diferenca.toFixed(2)} (novoTotal=${valorDepois})`,
    );
  }

  /**
   * Marca a sessão como EXPIRED (todas as tentativas esgotadas).
   */
  async expireSession(sessionId: string): Promise<void> {
    await this.prisma.fuelSession.update({
      where: { id: sessionId },
      data: { status: 'EXPIRED' },
    });
    this.logger.warn(`[FuelSession] Sessão ${sessionId} expirada`);
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { UsuarioDoApp } from 'src/boleto-notificacao/domain/regua-elegibilidade';

export interface ItemDoHistorico {
  userId: number;
  expoPushToken: string;
  title: string;
  body: string;
  data: unknown;
}

/** O lado "usuário do app" da régua: quem recebe, token e histórico do sino. */
@Injectable()
export class ReguaDestinatarioRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Usuários ativos com os CPFs/CNPJs informados. A busca é pela unique de
   * `user.cpf`; a base é conferida depois, em memória (o CPF é único no
   * deploy inteiro, e o cadastro antigo pode não ter base).
   */
  ativosPorCpf(cpfs: string[]): Promise<UsuarioDoApp[]> {
    return this.prisma.user.findMany({
      where: { cpf: { in: cpfs }, isActive: true },
      select: { id: true, cpf: true, baseOrigin: true, expoPushToken: true },
    });
  }

  /**
   * `DeviceNotRegistered`: o token está morto — apaga do usuário para não
   * insistir. Só apaga se o usuário ainda está com AQUELE token (ele pode
   * ter trocado de aparelho depois do envio).
   */
  async invalidarToken(userId: number, token: string): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, expoPushToken: token },
      data: { expoPushToken: null },
    });
    return count === 1;
  }

  /** Histórico do app (sino): só o que foi efetivamente aceito pelo Expo. */
  async gravarHistorico(itens: ItemDoHistorico[]): Promise<void> {
    if (itens.length === 0) return;
    await this.prisma.notification.createMany({
      data: itens.map((item) => ({
        userId: item.userId,
        expoPushToken: item.expoPushToken,
        title: item.title,
        body: item.body,
        data: item.data as Prisma.InputJsonValue,
        sentAt: new Date(),
      })),
    });
  }
}

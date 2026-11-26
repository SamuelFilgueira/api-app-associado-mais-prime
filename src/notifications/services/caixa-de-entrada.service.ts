import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Notification, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import type { DadosDoPush } from 'src/notifications/domain/push-mensagem';
import {
  GetNotificationsListResponseDto,
  GetNotificationsResponseDto,
} from 'src/notifications/dto/get-notifications-response.dto';

export interface NovaNotificacao {
  userId: number;
  expoPushToken: string;
  title: string;
  body: string;
  data: DadosDoPush;
}

/**
 * Caixa de entrada do app (`Notification`): o histórico que o associado vê
 * mesmo quando o push chegou com o app fechado. Exclusão é lógica.
 */
@Injectable()
export class CaixaDeEntradaService {
  private readonly logger = new Logger(CaixaDeEntradaService.name);

  constructor(private readonly prisma: PrismaService) {}

  gravar(nova: NovaNotificacao): Promise<Notification> {
    return this.prisma.notification.create({
      data: {
        userId: nova.userId,
        expoPushToken: nova.expoPushToken,
        title: nova.title,
        body: nova.body,
        data: nova.data as Prisma.InputJsonValue,
        sentAt: new Date(),
      },
    });
  }

  /**
   * Grava várias linhas de uma vez, só para usuários que ainda existem (a FK
   * derrubaria o lote inteiro por causa de um usuário apagado).
   */
  async gravarVarias(novas: NovaNotificacao[]): Promise<number> {
    if (novas.length === 0) return 0;
    const existentes = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(novas.map((n) => n.userId))] } },
      select: { id: true },
    });
    const vivos = new Set(existentes.map((u) => u.id));
    const agora = new Date();
    const linhas = novas
      .filter((n) => vivos.has(n.userId))
      .map((n) => ({
        userId: n.userId,
        expoPushToken: n.expoPushToken,
        title: n.title,
        body: n.body,
        data: n.data as Prisma.InputJsonValue,
        sentAt: agora,
      }));
    if (linhas.length === 0) return 0;
    const { count } = await this.prisma.notification.createMany({
      data: linhas,
    });
    return count;
  }

  async naoLidas(
    userId: number,
    limit: number = 50,
    offset: number = 0,
  ): Promise<GetNotificationsListResponseDto> {
    const where = { userId, read: false, deleted: false };
    const [notifications, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return new GetNotificationsListResponseDto(
      notifications.map((n) => new GetNotificationsResponseDto(n)),
      unreadCount,
      unreadCount,
    );
  }

  async todas(
    userId: number,
    limit: number = 50,
    offset: number = 0,
  ): Promise<GetNotificationsListResponseDto> {
    const where = { userId, deleted: false };
    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return new GetNotificationsListResponseDto(
      notifications.map((n) => new GetNotificationsResponseDto(n)),
      total,
    );
  }

  async marcarComoLida(
    userId: number,
    notificationId: number,
  ): Promise<Notification> {
    await this.exigirDoUsuario(userId, notificationId);
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { read: true, readAt: new Date() },
    });
  }

  async marcarTodasComoLidas(userId: number): Promise<{ count: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
    return { count };
  }

  async excluir(userId: number, notificationId: number): Promise<void> {
    const notification = await this.exigirDoUsuario(userId, notificationId);
    if (notification.deleted) {
      throw new NotFoundException(
        `Notificação #${notificationId} já foi deletada`,
      );
    }
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { deleted: true },
    });
  }

  async excluirTodas(userId: number): Promise<{ deletedCount: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, deleted: false },
      data: { deleted: true },
    });
    return { deletedCount: count };
  }

  /** Apaga de vez o que foi criado há mais de `daysOld` dias. */
  async limparAntigas(daysOld: number = 30): Promise<{ deletedCount: number }> {
    const corte = new Date();
    corte.setDate(corte.getDate() - daysOld);

    const { count } = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: corte } },
    });
    this.logger.log(
      `[Cleanup] ${count} notificações antigas removidas (>${daysOld} dias)`,
    );
    return { deletedCount: count };
  }

  private async exigirDoUsuario(
    userId: number,
    notificationId: number,
  ): Promise<Notification> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) {
      throw new NotFoundException(
        `Notificação #${notificationId} não encontrada`,
      );
    }
    if (notification.userId !== userId) {
      throw new ForbiddenException('Acesso negado a esta notificação');
    }
    return notification;
  }
}

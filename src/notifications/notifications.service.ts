import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Expo } from 'expo-server-sdk';
import { PrismaService } from '../prisma.service';
import { Notification } from '@prisma/client';
import {
  GetNotificationsResponseDto,
  GetNotificationsListResponseDto,
} from './DTOs/get-notifications-response.dto';

export type NotificationData = {
  plate?: string;
  ignition?: 'on' | 'off';
  [key: string]: any;
};

@Injectable()
export class NotificationsService {
  private expo = new Expo();
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Salva uma notificação no banco de dados
   */
  async saveNotification(
    userId: number,
    expoPushToken: string,
    title: string,
    body: string,
    data: NotificationData,
  ): Promise<Notification> {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        expoPushToken,
        title,
        body,
        data: data as any,
        sentAt: new Date(),
      },
    });

    this.logger.log(
      `🔔 [DB] Notificação #${notification.id} salva para user ${userId}`,
    );
    return notification;
  }

  /**
   * Envia notificação push via Expo e salva no banco
   */
  async sendPushNotification(
    userId: number,
    expoPushToken: string,
    title: string,
    body: string,
    data: NotificationData,
  ): Promise<{ success: boolean; message: string; notificationId?: number }> {
    if (!Expo.isExpoPushToken(expoPushToken)) {
      return { success: false, message: 'Token Expo inválido.' };
    }

    // Verificar se o usuário existe no banco (importante para constraint FK)
    const userExists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificacaoIgnicao: true },
    });

    if (!userExists) {
      return {
        success: false,
        message: `Usuario com ID ${userId} nao encontrado no banco.`,
      };
    }

    // Validar preferências de ignição se aplicável
    if (data?.ignition) {
      if (!userExists.notificacaoIgnicao) {
        return {
          success: false,
          message: 'Preferencia de notificacao de ignicao desativada.',
        };
      }
    }

    // Salvar no banco ANTES de enviar
    const savedNotification = await this.saveNotification(
      userId,
      expoPushToken,
      title,
      body,
      data,
    );

    const message = {
      to: expoPushToken,
      sound: 'default' as const,
      title,
      body,
      data,
    };

    try {
      await this.expo.sendPushNotificationsAsync([message]);
      this.logger.log(
        `📤 [Expo] Notificação #${savedNotification.id} enviada com sucesso`,
      );
      return {
        success: true,
        message: 'Notificação enviada com sucesso.',
        notificationId: savedNotification.id,
      };
    } catch (error) {
      this.logger.error(
        `❌ [Expo] Erro ao enviar notificação #${savedNotification.id}:`,
        error,
      );
      return {
        success: false,
        message: 'Erro ao enviar notificação.',
        notificationId: savedNotification.id,
      };
    }
  }

  /**
   * Obtém notificações não lidas do usuário
   */
  async getUnreadNotifications(
    userId: number,
    limit: number = 50,
    offset: number = 0,
  ): Promise<GetNotificationsListResponseDto> {
    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, read: false, deleted: false },
        orderBy: { sentAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.notification.count({
        where: { userId, read: false, deleted: false },
      }),
      this.prisma.notification.count({
        where: { userId, read: false, deleted: false },
      }),
    ]);

    this.logger.log(`📬 [Query] ${unreadCount} não lidas para user ${userId}`);

    const notificationDtos = notifications.map(
      (n) => new GetNotificationsResponseDto(n),
    );

    return new GetNotificationsListResponseDto(
      notificationDtos,
      total,
      unreadCount,
    );
  }

  /**
   * Obtém todas as notificações do usuário (lidas + não lidas)
   */
  async getAllNotifications(
    userId: number,
    limit: number = 50,
    offset: number = 0,
  ): Promise<GetNotificationsListResponseDto> {
    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, deleted: false },
        orderBy: { sentAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.notification.count({
        where: { userId, deleted: false },
      }),
    ]);

    this.logger.log(
      `📋 [Query] ${notifications.length} notificações para user ${userId}`,
    );

    const notificationDtos = notifications.map(
      (n) => new GetNotificationsResponseDto(n),
    );

    return new GetNotificationsListResponseDto(notificationDtos, total);
  }

  /**
   * Marca uma notificação como lida
   */
  async markAsRead(
    userId: number,
    notificationId: number,
  ): Promise<Notification> {
    // Verifica se a notificação existe e pertence ao usuário
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

    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        read: true,
        readAt: new Date(),
      },
    });

    this.logger.log(
      `✅ [Update] Notificação #${notificationId} marcada como lida`,
    );
    return updated;
  }

  /**
   * Marca todas as notificações como lidas
   */
  async markAllAsRead(userId: number): Promise<{ count: number }> {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        read: false,
      },
      data: {
        read: true,
        readAt: new Date(),
      },
    });

    this.logger.log(
      `✅ [Update] ${result.count} notificações marcadas como lidas para user ${userId}`,
    );
    return { count: result.count };
  }

  /**
   * Deleta uma notificação
   */
  async deleteNotification(
    userId: number,
    notificationId: number,
  ): Promise<void> {
    // Verifica se a notificação existe e pertence ao usuário
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

    if (notification.deleted) {
      throw new NotFoundException(
        `Notificação #${notificationId} já foi deletada`,
      );
    }

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        deleted: true,
      },
    });

    this.logger.log(`🗑️ [Delete] Notificação #${notificationId} deletada`);
  }

  /**
   * Marca todas as notificações de um usuário como deletadas (soft delete)
   */
  async deleteAllUserNotifications(
    userId: number,
  ): Promise<{ deletedCount: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, deleted: false },
      data: { deleted: true },
    });

    this.logger.log(
      `🗑️ [DeleteAll] ${result.count} notificações marcadas como deletadas para user ${userId}`,
    );
    return { deletedCount: result.count };
  }

  /**
   * Limpa notificações antigas (>30 dias por padrão)
   */
  async cleanOldNotifications(
    daysOld: number = 30,
  ): Promise<{ deletedCount: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.prisma.notification.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate,
        },
      },
    });

    this.logger.log(
      `🧹 [Cleanup] ${result.count} notificações antigas removidas (>${daysOld} dias)`,
    );
    return { deletedCount: result.count };
  }

  /**
   * Envia notificacoes de marketing para usuarios opt-in
   * Apenas ADMIN pode chamar este método
   */
  async sendMarketingNotification(
    payload: {
      title: string;
      body: string;
      data?: Record<string, any>;
    },
    adminUserId?: number,
  ): Promise<{ sentCount: number; skippedCount: number }> {
    // Validar que quem está chamando é ADMIN
    if (adminUserId) {
      const admin = await this.prisma.user.findUnique({
        where: { id: adminUserId },
        select: { role: true },
      });

      if (!admin || admin.role !== 'ADMIN') {
        throw new ForbiddenException(
          'Apenas usuarios com role ADMIN podem enviar notificacoes de marketing.',
        );
      }
    }

    const dataPayload = payload.data ?? { type: 'marketing' };

    const recipients = await this.prisma.notification.findMany({
      where: {
        deleted: false,
        user: {
          acceptsMarketingNotifications: true,
          isActive: true,
        },
      },
      orderBy: { sentAt: 'desc' },
      distinct: ['userId'],
      select: {
        userId: true,
        expoPushToken: true,
      },
    });

    const validRecipients = recipients.filter((recipient) =>
      Expo.isExpoPushToken(recipient.expoPushToken),
    );

    if (validRecipients.length === 0) {
      return { sentCount: 0, skippedCount: recipients.length };
    }

    const messages = validRecipients.map((recipient) => ({
      to: recipient.expoPushToken,
      sound: 'default' as const,
      title: payload.title,
      body: payload.body,
      data: dataPayload,
    }));

    const chunks = this.expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await this.expo.sendPushNotificationsAsync(chunk);
    }

    await this.prisma.notification.createMany({
      data: validRecipients.map((recipient) => ({
        userId: recipient.userId,
        expoPushToken: recipient.expoPushToken,
        title: payload.title,
        body: payload.body,
        data: dataPayload as any,
        sentAt: new Date(),
      })),
    });

    return {
      sentCount: validRecipients.length,
      skippedCount: recipients.length - validRecipients.length,
    };
  }
}

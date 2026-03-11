import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
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

  private maskExpoPushToken(token?: string | null): string {
    if (!token) return 'ausente';
    if (token.length <= 16) return token;
    return `${token.slice(0, 12)}...${token.slice(-4)}`;
  }

  private buildExpoMessage(
    expoPushToken: string,
    title: string,
    body: string,
    data: NotificationData,
  ): ExpoPushMessage {
    return {
      to: expoPushToken,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'alerts_v2',
      _contentAvailable: true,
      mutableContent: true, // precisa bater com o canal do app
      //_contentAvailable: true, // iOS background/killed
      //mutableContent: true, // iOS compat
      //ttl: 60 * 60, // 1h
      //expiration: Math.floor(Date.now() / 1000) + 60 * 60,
    };
  }

  async registerExpoPushToken(
    userId: number,
    expoPushToken: string,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(
      `📝 [Token] Registrando expoPushToken para user ${userId}: ${this.maskExpoPushToken(expoPushToken)}`,
    );

    if (!Expo.isExpoPushToken(expoPushToken)) {
      this.logger.warn(
        `⚠️ [Token] expoPushToken inválido para user ${userId}: ${this.maskExpoPushToken(expoPushToken)}`,
      );
      return { success: false, message: 'Token Expo inválido.' };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      return {
        success: false,
        message: `Usuario com ID ${userId} nao encontrado no banco.`,
      };
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { expoPushToken },
    });

    return { success: true, message: 'Token Expo registrado com sucesso.' };
  }

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
    this.logger.log(
      `🧾 [DB] Definindo expoPushToken para persistência: ${this.maskExpoPushToken(expoPushToken)} (user ${userId})`,
    );

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
    this.logger.log(
      `📲 [Push] expoPushToken recebido para envio: ${this.maskExpoPushToken(expoPushToken)} (user ${userId})`,
    );

    if (!Expo.isExpoPushToken(expoPushToken)) {
      this.logger.warn(
        `⚠️ [Push] expoPushToken inválido: ${this.maskExpoPushToken(expoPushToken)} (user ${userId})`,
      );
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
    if (data?.ignition && !userExists.notificacaoIgnicao) {
      return {
        success: false,
        message: 'Preferencia de notificacao de ignicao desativada.',
      };
    }

    // Salvar no banco ANTES de enviar
    const savedNotification = await this.saveNotification(
      userId,
      expoPushToken,
      title,
      body,
      data,
    );

    const message = this.buildExpoMessage(expoPushToken, title, body, data);

    try {
      const tickets = await this.expo.sendPushNotificationsAsync([message]);
      const firstTicket = tickets?.[0];

      const receiptIds = tickets
        .filter((ticket) => ticket.status === 'ok')
        .map((ticket) => ticket.id);

      if (receiptIds.length) {
        const receipts = await this.expo.getPushNotificationReceiptsAsync(receiptIds);

        for (const receiptId in receipts) {
          const receipt = receipts[receiptId];

          if (receipt.status === 'error') {
            this.logger.error(
              `❌ [Expo Receipt] erro na entrega: ${receipt.message}`,
              receipt.details,
            );
          }
        }
      }

      if (firstTicket?.status === 'error') {
        this.logger.warn(
          `⚠️ [Expo] Ticket erro para notificação #${savedNotification.id}: ${firstTicket.message ?? 'erro desconhecido'}`,
        );
        return {
          success: false,
          message: firstTicket.message || 'Erro no ticket Expo.',
          notificationId: savedNotification.id,
        };
      }

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
    const [notifications, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, read: false, deleted: false },
        orderBy: { sentAt: 'desc' },
        skip: offset,
        take: limit,
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
      unreadCount,
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
   * Disparada pelo processador de webhook M7.
   */
  async dispararNotificacaoVeiculoWebhook(
    chassi: string,
    tipoevento: number | null,
    evento: string | null,
  ): Promise<{ sent: number; skipped: number }> {
    const eventoLower = evento?.toLowerCase() ?? '';

    const isIgnicaoLigada = tipoevento === 32 || evento === 'Ignição Ligada';

    const isAncoraViolada =
      tipoevento === 16 ||
      eventoLower.includes('violação de ancora') ||
      eventoLower.includes('violacao de ancora');

    if (!isIgnicaoLigada && !isAncoraViolada) {
      this.logger.log(
        `[Webhook] Evento sem mapeamento de notificação: tipoevento=${tipoevento}, evento="${evento}" — ignorando`,
      );
      return { sent: 0, skipped: 0 };
    }

    const userVehicles = await this.prisma.userVehicle.findMany({
      where: {
        chassi,
        isActive: true,
        user: { notificacaoIgnicao: true, isActive: true },
      },
      select: {
        userId: true,
        plate: true,
      },
    });

    if (userVehicles.length === 0) {
      this.logger.log(
        `[Webhook] Nenhum usuário com notificacaoIgnicao ativa para chassi "${chassi}"`,
      );
      return { sent: 0, skipped: 0 };
    }

    const userIds = userVehicles.map((v) => v.userId);

    const usersWithToken = await this.prisma.user.findMany({
      where: {
        id: { in: userIds },
        isActive: true,
        expoPushToken: { not: null },
      },
      select: { id: true, expoPushToken: true },
    });

    const tokenMap = new Map(
      usersWithToken
        .filter((u) => !!u.expoPushToken)
        .map((u) => [u.id, u.expoPushToken as string]),
    );
    const plateMap = new Map(userVehicles.map((v) => [v.userId, v.plate]));

    let sent = 0;
    let skipped = 0;

    for (const { userId } of userVehicles) {
      const expoPushToken = tokenMap.get(userId);

      this.logger.log(
        `[Webhook] expoPushToken resolvido para user ${userId}: ${this.maskExpoPushToken(expoPushToken)}`,
      );

      if (!expoPushToken || !Expo.isExpoPushToken(expoPushToken)) {
        this.logger.warn(
          `[Webhook] Token inválido ou ausente para user ${userId} — ignorando`,
        );
        skipped++;
        continue;
      }

      const plate = plateMap.get(userId);
      const vehicleLabel = plate ? `placa ${plate}` : `chassi ${chassi}`;

      let title: string;
      let body: string;
      let data: NotificationData;

      if (isIgnicaoLigada) {
        title = 'Ignição Ligada 🔑';
        body = `A ignição do seu veículo (${vehicleLabel}) foi ligada.`;
        data = {
          chassi,
          plate: plate ?? undefined,
          ignition: 'on',
          eventType: 'ignition_on',
        };
      } else {
        title = 'Violação de Âncora ⚠️';
        body = `Violação de âncora detectada no seu veículo (${vehicleLabel}).`;
        data = {
          chassi,
          plate: plate ?? undefined,
          eventType: 'ancora_violation',
        };
      }

      const result = await this.sendPushNotification(
        userId,
        expoPushToken,
        title,
        body,
        data,
      );

      if (result.success) {
        sent++;
        this.logger.log(
          `[Webhook] Notificação "${title}" enviada para user ${userId} (${vehicleLabel})`,
        );
      } else {
        skipped++;
        this.logger.warn(
          `[Webhook] Falha ao enviar notificação para user ${userId}: ${result.message}`,
        );
      }
    }

    this.logger.log(
      `[Webhook] Resultado para chassi "${chassi}": enviadas=${sent}, ignoradas=${skipped}`,
    );
    return { sent, skipped };
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

    const recipients = await this.prisma.user.findMany({
      where: {
        isActive: true,
        acceptsMarketingNotifications: true,
        expoPushToken: { not: null },
      },
      select: {
        id: true,
        expoPushToken: true,
      },
    });

    const validRecipients: Array<{ id: number; expoPushToken: string }> = [];
    for (const recipient of recipients) {
      if (
        recipient.expoPushToken &&
        Expo.isExpoPushToken(recipient.expoPushToken)
      ) {
        validRecipients.push({
          id: recipient.id,
          expoPushToken: recipient.expoPushToken,
        });
      }
    }

    if (validRecipients.length === 0) {
      return { sentCount: 0, skippedCount: recipients.length };
    }

    const messages: ExpoPushMessage[] = validRecipients.map((recipient) =>
      this.buildExpoMessage(
        recipient.expoPushToken,
        payload.title,
        payload.body,
        dataPayload,
      ),
    );

    const chunks = this.expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await this.expo.sendPushNotificationsAsync(chunk);
    }

    await this.prisma.notification.createMany({
      data: validRecipients.map((recipient) => ({
        userId: recipient.id,
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

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
   * Disparada pelo processador de webhook M7.
   *
   * Regras:
   *  - tipoevento === 32 ou evento === 'Ignição Ligada'  → notificação de ignição ligada
   *  - tipoevento === 16 ou evento contém 'violação de ancora' → notificação de âncora violada
   *
   * Apenas usuários com `notificacaoIgnicao = true` que possuam um
   * `UserVehicle` ativo com o chassi recebido serão notificados.
   */
  async dispararNotificacaoVeiculoWebhook(
    chassi: string,
    tipoevento: number | null,
    evento: string | null,
  ): Promise<{ sent: number; skipped: number }> {
    const eventoLower = evento?.toLowerCase() ?? '';

    const isIgnicaoLigada =
      tipoevento === 32 || evento === 'Ignição Ligada';

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

    // Buscar veículos com esse chassi cujo usuário tem a flag ativa
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

    // Obter o token Expo mais recente de cada usuário
    const latestTokens = await this.prisma.notification.findMany({
      where: { userId: { in: userIds }, deleted: false },
      orderBy: { sentAt: 'desc' },
      distinct: ['userId'],
      select: { userId: true, expoPushToken: true },
    });

    const tokenMap = new Map(latestTokens.map((t) => [t.userId, t.expoPushToken]));
    const plateMap = new Map(userVehicles.map((v) => [v.userId, v.plate]));

    let sent = 0;
    let skipped = 0;

    for (const { userId } of userVehicles) {
      const expoPushToken = tokenMap.get(userId);

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
        data = { chassi, plate: plate ?? undefined, ignition: 'on', eventType: 'ignition_on' };
      } else {
        title = 'Violação de Âncora ⚠️';
        body = `Violação de âncora detectada no seu veículo (${vehicleLabel}).`;
        data = { chassi, plate: plate ?? undefined, eventType: 'ancora_violation' };
      }

      const result = await this.sendPushNotification(userId, expoPushToken, title, body, data);

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

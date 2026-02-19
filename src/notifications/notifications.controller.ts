import {
  Body,
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationsService } from './notifications.service';
import { TestNotificationDto } from './DTOs/test-notification.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTokenGuard } from './admin-token.guard';
import { SendMarketingNotificationDto } from './DTOs/send-marketing-notification.dto';
import { NOTIFICATION_QUEUE } from '../queue/queue.module';

@Controller('notifications')
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue: Queue,
  ) {}

  /**
   * POST /notifications/queue-test
   * Enfileira a notificação no BullMQ em vez de enviar diretamente.
   * Use este endpoint para verificar se a fila está operacional.
   */
  @Post('queue-test')
  async queueTestNotification(@Body() dto: TestNotificationDto) {
    const data = { plate: dto.plate, ignition: dto.ignition };
    const job = await this.notificationQueue.add(
      'push-test',
      {
        userId: dto.userId ?? 1,
        expoPushToken: dto.expoPushToken,
        title: dto.title,
        body: dto.body,
        data,
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    );
    this.logger.log(`[QUEUE] Job #${job.id} enfileirado para user ${dto.userId}`);
    return {
      queued: true,
      jobId: job.id,
      queue: NOTIFICATION_QUEUE,
      enqueuedAt: new Date().toISOString(),
    };
  }

  @Post('test')
  async testNotification(@Body() dto: TestNotificationDto) {
    const data = {
      plate: dto.plate,
      ignition: dto.ignition,
    };
    this.logger.log(
      `Enviando notificação de teste com dados: ${JSON.stringify(data)}`,
    );
    // Nota: Para teste, usando um userId padrão (1)
    // Em produção, isso viria do token JWT
    return this.notificationsService.sendPushNotification(
      dto.userId ?? 1,
      dto.expoPushToken,
      dto.title,
      dto.body,
      data,
    );
  }

  /**
   * GET /notifications/user/:userId/unread
   * Obtém notificações não lidas do usuário
   */
  @UseGuards(JwtAuthGuard)
  @Get('user/:userId/unread')
  async getUnreadNotifications(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Request() req?: any,
  ) {
    // Validar que o userId do token corresponde ao userId do params
    if (req.user && req.user.userId !== userId) {
      throw new ForbiddenException(
        'Acesso negado: voce so pode ver suas proprias notificacoes',
      );
    }

    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    return this.notificationsService.getUnreadNotifications(
      userId,
      limitNum,
      offsetNum,
    );
  }

  /**
   * GET /notifications/user/:userId
   * Obtém todas as notificações do usuário
   */
  @UseGuards(JwtAuthGuard)
  @Get('user/:userId')
  async getAllNotifications(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Request() req?: any,
  ) {
    // Validar que o userId do token corresponde ao userId do params
    if (req.user && req.user.userId !== userId) {
      throw new ForbiddenException(
        'Acesso negado: voce so pode ver suas proprias notificacoes',
      );
    }

    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    return this.notificationsService.getAllNotifications(
      userId,
      limitNum,
      offsetNum,
    );
  }

  /**
   * PATCH /notifications/:notificationId/read
   * Marca uma notificação como lida
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':notificationId/read')
  async markAsRead(
    @Param('notificationId', ParseIntPipe) notificationId: number,
    @Request() req: any,
  ) {
    const userId = req.user.userId;
    return this.notificationsService.markAsRead(userId, notificationId);
  }

  /**
   * PATCH /notifications/user/:userId/read-all
   * Marca todas as notificações como lidas
   */
  @UseGuards(JwtAuthGuard)
  @Patch('user/:userId/read-all')
  async markAllAsRead(
    @Param('userId', ParseIntPipe) userId: number,
    @Request() req: any,
  ) {
    // Validar que o userId do token corresponde ao userId do params
    if (req.user.userId !== userId) {
      throw new ForbiddenException(
        'Acesso negado: voce so pode marcar suas proprias notificacoes',
      );
    }

    return this.notificationsService.markAllAsRead(userId);
  }

  /**
   * PATCH /notifications/user/:userId/delete-all
   * Marca todas as notificações de um usuário como deletadas (soft delete)
   */
  @UseGuards(JwtAuthGuard)
  @Patch('user/:userId/delete-all')
  @HttpCode(HttpStatus.OK)
  async deleteAllUserNotifications(
    @Param('userId', ParseIntPipe) userId: number,
    @Request() req: any,
  ) {
    // Validar que o userId do token corresponde ao userId do params
    if (req.user.userId !== userId) {
      throw new ForbiddenException(
        'Acesso negado: voce so pode deletar suas proprias notificacoes',
      );
    }

    const result =
      await this.notificationsService.deleteAllUserNotifications(userId);
    return {
      success: true,
      message: `${result.deletedCount} notificações marcadas como deletadas com sucesso`,
      deletedCount: result.deletedCount,
    };
  }

  /**
   * PATCH /notifications/:notificationId
   * Deleta uma notificação
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':notificationId')
  @HttpCode(HttpStatus.OK)
  async deleteNotification(
    @Param('notificationId', ParseIntPipe) notificationId: number,
    @Request() req: any,
  ) {
    const userId = req.user.userId;
    await this.notificationsService.deleteNotification(userId, notificationId);
    return { success: true, message: 'Notificação deletada com sucesso' };
  }

  /**
   * POST /notifications/admin/marketing
   * Envia notificacoes de marketing em massa (painel administrativo)
   */
  @UseGuards(JwtAuthGuard)
  @Post('admin/marketing')
  @HttpCode(HttpStatus.OK)
  async sendMarketingNotification(@Body() dto: SendMarketingNotificationDto) {
    return this.notificationsService.sendMarketingNotification(dto);
  }
}

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
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { TestNotificationDto } from './DTOs/test-notification.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminTokenGuard } from './admin-token.guard';
import { SendMarketingNotificationDto } from './DTOs/send-marketing-notification.dto';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('test')
  async testNotification(@Body() dto: TestNotificationDto) {
    const data = {
      plate: dto.plate,
      ignition: dto.ignition,
    };
    console.log('📱 Enviando notificação de teste com dados:', data);
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

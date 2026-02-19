import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { NOTIFICATION_QUEUE } from '../queue/queue.module';
import { NotificationsService } from './notifications.service';

export interface NotificationJobData {
  userId: number;
  expoPushToken: string;
  title: string;
  body: string;
  data: Record<string, any>;
}

/**
 * Processor que consome jobs da fila de notificações.
 *
 * Desacopla o envio de push notifications do fluxo HTTP, garantindo:
 *   1. Respostas rápidas nos endpoints que disparam notificações.
 *   2. Retry automático em caso de falha no Expo push service.
 *   3. Controle de concorrência (evita burst de requests ao Expo).
 */
@Processor(NOTIFICATION_QUEUE, { concurrency: 3 })
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly notificationsService: NotificationsService) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<any> {
    const { userId, expoPushToken, title, body, data } = job.data;
    const start = Date.now();

    this.logger.log(
      `[QUEUE] ▶ job #${job.id} | user=${userId} | tentativa=${job.attemptsMade + 1} | nome="${job.name}"`,
    );

    try {
      const result = await this.notificationsService.sendPushNotification(
        userId,
        expoPushToken,
        title,
        body,
        data,
      );
      const elapsed = Date.now() - start;
      this.logger.log(
        `[QUEUE] ✔ job #${job.id} concluído em ${elapsed}ms — ${result.message}`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `[QUEUE] ✖ job #${job.id} falhou (tentativa ${job.attemptsMade + 1}): ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(
      `[QUEUE] ⚡ job #${job.id} ativado — fila: ${job.queueName}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `[QUEUE] ✖ job #${job.id} falhou definitivamente após ${job.attemptsMade} tentativas: ${error.message}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`[QUEUE] ✔ job #${job.id} processado e removido da fila`);
  }
}

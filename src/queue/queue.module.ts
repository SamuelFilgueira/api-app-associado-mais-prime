import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

export const WEBHOOK_QUEUE = 'webhook-events';
export const NOTIFICATION_QUEUE = 'notifications';

/**
 * Módulo global que configura o BullMQ com Redis.
 *
 * As variáveis de ambiente utilizadas:
 *  - REDIS_HOST (padrão: localhost)
 *  - REDIS_PORT (padrão: 6379)
 *
 * Em Docker, REDIS_HOST deve apontar para o nome do serviço do container Redis
 * (ex.: "redis"), nunca "localhost".
 */
@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
    }),

    // Registra as filas que serão injetadas pela aplicação
    BullModule.registerQueue(
      { name: WEBHOOK_QUEUE },
      { name: NOTIFICATION_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}

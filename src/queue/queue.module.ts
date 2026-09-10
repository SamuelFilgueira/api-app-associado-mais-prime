import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

export const WEBHOOK_QUEUE = 'webhook-events';
export const NOTIFICATION_QUEUE = 'notifications';
export const FUEL_ECONOMY_QUEUE = 'fuel-economy';
export const BOLETO_VERIFICACAO_QUEUE = 'boleto-verificacao';
export const ANALYTICS_QUEUE = 'analytics-summaries';
export const BOLETO_NOTIFICACAO_QUEUE = 'boleto-notificacao';

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
/**
 * Retenção padrão de jobs no Redis (aprovada como pendência B9):
 * antes, 4 das 6 filas acumulavam jobs concluídos/falhos para sempre.
 * Opções passadas no `queue.add(...)` de cada call-site continuam prevalecendo.
 * Nenhum default de attempts/backoff aqui — mudaria o retry de quem não
 * configura (pendência B1).
 */
const DEFAULT_JOB_RETENTION = {
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 86_400 },
};

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
      defaultJobOptions: DEFAULT_JOB_RETENTION,
    }),

    // Registra as filas que serão injetadas pela aplicação
    BullModule.registerQueue(
      { name: WEBHOOK_QUEUE },
      { name: NOTIFICATION_QUEUE },
      { name: FUEL_ECONOMY_QUEUE },
      { name: BOLETO_VERIFICACAO_QUEUE },
      { name: ANALYTICS_QUEUE },
      { name: BOLETO_NOTIFICACAO_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}

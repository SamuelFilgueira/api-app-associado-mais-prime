import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FUEL_ECONOMY_QUEUE } from 'src/queue/queue.module';
import { FuelSessionService } from 'src/fuel-session/services/fuel-session.service';
import { EconomiaService } from 'src/economia/services/economia.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { PrismaService } from 'src/database/prisma.service';

export interface FuelEconomyJobData {
  fuelSessionId: string;
}

/**
 * Processor BullMQ que verifica se houve abastecimento após um delay de 5 minutos.
 *
 * Lógica:
 *   1. Busca a FuelSession pelo id
 *   2. Se status != PENDING → idempotência, sai sem fazer nada
 *   3. Consulta a API externa de economia
 *   4. Se novoValor > valorAntes → completa sessão e envia push
 *   5. Se sem variação → lança erro para acionar retry do BullMQ
 *   6. Se todas as tentativas esgotadas → marca sessão como EXPIRED
 */
@Processor(FUEL_ECONOMY_QUEUE, { concurrency: 2 })
export class FuelEconomyProcessor extends WorkerHost {
  private readonly logger = new Logger(FuelEconomyProcessor.name);

  constructor(
    private readonly fuelSessionService: FuelSessionService,
    private readonly economiaService: EconomiaService,
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<FuelEconomyJobData>): Promise<any> {
    const { fuelSessionId } = job.data;
    const attempt = job.attemptsMade + 1;

    this.logger.log(
      `[FUEL] ▶ job #${job.id} | sessionId=${fuelSessionId} | tentativa=${attempt}/${job.opts.attempts ?? 1}`,
    );

    // 1. Buscar sessão
    const session = await this.fuelSessionService.findById(fuelSessionId);

    if (!session) {
      this.logger.warn(
        `[FUEL] ⚠ job #${job.id} | FuelSession ${fuelSessionId} não encontrada — ignorando`,
      );
      return { skipped: true, reason: 'session_not_found' };
    }

    // 2. Idempotência: se já foi processada, não processar novamente
    if (session.status !== 'PENDING') {
      this.logger.log(
        `[FUEL] ↩ job #${job.id} | FuelSession ${fuelSessionId} status=${session.status} — já processada, ignorando`,
      );
      return { skipped: true, reason: 'already_processed', status: session.status };
    }

    // 3. Consultar API externa
    const response = await this.economiaService.consultarTotalEconomizado(
      session.userId,
    );

    if (response.errors?.length) {
      this.logger.error(
        `[FUEL] ✖ job #${job.id} | Erros na API externa: ${JSON.stringify(response.errors)}`,
      );
      throw new Error(`Erro na API externa de economia: ${JSON.stringify(response.errors)}`);
    }

    const novoValor = parseFloat(response.totalEconomizado);

    if (isNaN(novoValor)) {
      this.logger.error(
        `[FUEL] ✖ job #${job.id} | totalEconomizado inválido recebido: "${response.totalEconomizado}"`,
      );
      throw new Error(`Valor inválido retornado pela API externa: "${response.totalEconomizado}"`);
    }

    const { valorAntes, userId } = session;

    // 4. Verificar se houve abastecimento
    if (novoValor > valorAntes) {
      const diferenca = novoValor - valorAntes;

      this.logger.log(
        `[FUEL] ✔ job #${job.id} | Abastecimento detectado para user ${userId}: valorAntes=${valorAntes} novoValor=${novoValor} diferenca=${diferenca.toFixed(2)}`,
      );

      // Completar sessão + atualizar user em transação
      await this.fuelSessionService.completeSession(
        fuelSessionId,
        novoValor,
        diferenca,
        userId,
      );

      // Buscar token push do usuário
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { expoPushToken: true },
      });

      if (user?.expoPushToken) {
        await this.notificationsService.sendPushNotification(
          userId,
          user.expoPushToken,
          'Abastecimento detectado! 🎉',
          `Parabéns! Você economizou R$ ${diferenca.toFixed(2).replace('.', ',')} neste abastecimento.`,
          { type: 'fuel_economy', diferenca, novoTotal: novoValor },
        );
        this.logger.log(
          `[FUEL] 🔔 Push enviado para user ${userId} — economizou R$ ${diferenca.toFixed(2)}`,
        );
      } else {
        this.logger.warn(
          `[FUEL] ⚠ job #${job.id} | user ${userId} sem expoPushToken — push não enviado`,
        );
      }

      return { processed: true, diferenca, novoTotal: novoValor };
    }

    // 5. Sem variação → acionar retry
    this.logger.log(
      `[FUEL] ↩ job #${job.id} | Sem variação no totalEconomizado (valorAntes=${valorAntes} atual=${novoValor}) — aguardando retry`,
    );
    throw new Error(
      `Sem variação no totalEconomizado (antes=${valorAntes} atual=${novoValor})`,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<FuelEconomyJobData>,
    error: Error,
  ): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade >= maxAttempts;

    if (isLastAttempt) {
      this.logger.warn(
        `[FUEL] ⛔ job #${job.id} | Todas as ${maxAttempts} tentativas esgotadas para session=${job.data.fuelSessionId} — expirando sessão`,
      );
      try {
        await this.fuelSessionService.expireSession(job.data.fuelSessionId);
      } catch (expireError) {
        this.logger.error(
          `[FUEL] ✖ Erro ao expirar FuelSession ${job.data.fuelSessionId}: ${expireError instanceof Error ? expireError.message : String(expireError)}`,
        );
      }
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job): void {
    this.logger.log(
      `[FUEL] ⚙ job #${job.id} ativo (tentativa ${job.attemptsMade + 1})`,
    );
  }
}

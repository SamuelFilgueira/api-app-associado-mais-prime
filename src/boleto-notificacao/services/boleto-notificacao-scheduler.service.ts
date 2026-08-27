import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BOLETO_NOTIFICACAO_QUEUE } from 'src/queue/queue.module';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { JOB_EXECUTAR_ROTINA } from 'src/boleto-notificacao/services/boleto-notificacao.service';

export const TIMEZONE_ROTINA = 'America/Sao_Paulo';
const JOB_ID_AGENDADO = 'boleto-notificacao-diaria';

/**
 * Registra (ou remove) o repeatable job diário no BullMQ, no padrão já usado
 * pelo projeto (sga.service.ts). O cron vem de BOLETO_NOTIFICACAO_HORARIO.
 *
 * O jobId fixo garante que múltiplas réplicas da API não dupliquem o agendamento.
 */
@Injectable()
export class BoletoNotificacaoSchedulerService
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(BoletoNotificacaoSchedulerService.name);

  constructor(
    @InjectQueue(BOLETO_NOTIFICACAO_QUEUE) private readonly queue: Queue,
    private readonly configService: BoletoNotificacaoConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sincronizarAgendamento();
    } catch (error) {
      // Não derruba o boot: a rotina pode ser disparada manualmente pelo admin
      this.logger.error(
        `[BOLETO-NOTIF][SCHEDULER] falha ao sincronizar agendamento: ${error.message}`,
      );
    }
  }

  /** Remove agendamentos antigos e registra o atual (se habilitado). */
  async sincronizarAgendamento(): Promise<{ enabled: boolean; cron: string }> {
    const config = this.configService.get();

    const existentes = await this.queue.getRepeatableJobs();
    for (const repeatable of existentes) {
      if (repeatable.name === JOB_EXECUTAR_ROTINA) {
        await this.queue.removeRepeatableByKey(repeatable.key);
      }
    }

    if (!config.enabled) {
      this.logger.warn(
        '[BOLETO-NOTIF][SCHEDULER] rotina DESABILITADA (BOLETO_NOTIFICACAO_ENABLED != true) — nenhum disparo automático será feito',
      );
      return { enabled: false, cron: config.cronPattern };
    }

    await this.queue.add(
      JOB_EXECUTAR_ROTINA,
      { origem: 'AGENDADA' },
      {
        repeat: { pattern: config.cronPattern, tz: TIMEZONE_ROTINA },
        jobId: JOB_ID_AGENDADO,
        attempts: 2,
        backoff: { type: 'fixed', delay: 5 * 60_000 },
        removeOnComplete: 30,
        removeOnFail: 30,
      },
    );

    this.logger.log(
      `[BOLETO-NOTIF][SCHEDULER] rotina agendada: todo dia às ${config.horario} (${TIMEZONE_ROTINA}) — cron "${config.cronPattern}"`,
    );
    return { enabled: true, cron: config.cronPattern };
  }

  /** Estado atual do agendamento no Redis (apoio ao endpoint admin). */
  async statusAgendamento() {
    const config = this.configService.get();
    const repeatables = await this.queue.getRepeatableJobs();
    const ativo = repeatables.find((r) => r.name === JOB_EXECUTAR_ROTINA);
    return {
      enabled: config.enabled,
      horario: config.horario,
      timezone: TIMEZONE_ROTINA,
      cron: config.cronPattern,
      registradoNoRedis: !!ativo,
      proximaExecucao: ativo?.next ? new Date(ativo.next).toISOString() : null,
    };
  }
}

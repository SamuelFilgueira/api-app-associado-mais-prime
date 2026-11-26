import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { papelAtivo } from 'src/config/app.config';
import { metricas } from 'src/infra/observability/metricas';
import { baseTag } from 'src/shared/log.util';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { ReguaExecucaoRepository } from 'src/boleto-notificacao/repositories/regua-execucao.repository';

/**
 * Gauge `boleto_regua_ultima_execucao_timestamp_seconds{base}`, que alimenta
 * o alerta "régua não rodou há mais de 26 h".
 *
 * O gauge vive na memória do processo: sem restaurá-lo no boot, um restart
 * do worker zeraria a série e o alerta ficaria mudo até a próxima execução
 * bem-sucedida — justamente quando a régua pode estar parada.
 */
@Injectable()
export class ReguaMetricaService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReguaMetricaService.name);

  constructor(
    private readonly execucoes: ReguaExecucaoRepository,
    private readonly configService: BoletoNotificacaoConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Só o worker roda a régua; é dele a série que o alerta observa.
    if (!papelAtivo('worker')) return;
    // Com a rotina desligada não há o que vigiar: repor a série de uma
    // execução antiga faria o alerta disparar a cada restart.
    if (!this.configService.get().enabled) return;
    await this.restaurar();
  }

  /**
   * A régua da base concluiu agora. Só bases configuradas neste deploy viram
   * série: o rótulo `base` é um conjunto fechado (a rota manual aceita
   * qualquer texto em `tenants`).
   */
  registrarConclusao(base: string, instante: Date = new Date()): void {
    if (!this.configService.get().tenants.includes(base)) return;
    metricas.boletoReguaUltimaExecucao.set(
      { base },
      Math.floor(instante.getTime() / 1000),
    );
  }

  /**
   * Repõe o gauge com a última execução `CONCLUIDA` de cada base, lida do
   * banco. Base que nunca concluiu fica sem série.
   */
  async restaurar(): Promise<string[]> {
    const ultimas = await this.execucoes.ultimaConclusaoPorBase(
      this.configService.get().tenants,
    );
    for (const [base, instante] of ultimas) {
      this.registrarConclusao(base, instante);
      this.logger.log(
        `[BOLETO-NOTIF]${baseTag(base)} última execução concluída da régua: ${instante.toISOString()}`,
      );
    }
    return Array.from(ultimas.keys());
  }
}

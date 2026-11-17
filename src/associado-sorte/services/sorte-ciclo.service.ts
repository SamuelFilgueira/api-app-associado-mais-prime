import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  associadoSorteConfig,
  SORTE_CICLO_JOB,
  SORTE_CICLO_SCHEDULER_ID,
} from 'src/associado-sorte/config/associado-sorte.config';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { SorteApuracaoService } from 'src/associado-sorte/services/sorte-apuracao.service';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteLembreteRaspadaService } from 'src/associado-sorte/services/sorte-lembrete-raspada.service';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';
import { ASSOCIADO_SORTE_QUEUE } from 'src/queue/queue.module';

export interface CicloResultado {
  sorteiosApurados: number;
  rodadasEncerradas: number;
  lembretesEnfileirados: number;
  campanhasEncerradas: number;
  lembretesRaspadaEnfileirados: number;
}

/**
 * Trabalho periódico do Associado da Sorte (seção 5.3). Um job que consulta
 * o banco a cada poucos segundos continua correto se o painel mudar o
 * horário de uma rodada ou se o servidor reiniciar (não há job por rodada).
 */
@Injectable()
export class SorteCicloService implements OnModuleInit {
  private readonly logger = new Logger(SorteCicloService.name);

  constructor(
    @InjectQueue(ASSOCIADO_SORTE_QUEUE) private readonly fila: Queue,
    private readonly rodadasRepository: SorteRodadasRepository,
    private readonly apuracao: SorteApuracaoService,
    private readonly notificacoes: SorteNotificacoesService,
    private readonly campanhas: SorteCampanhaService,
    private readonly lembreteRaspada: SorteLembreteRaspadaService,
  ) {}

  /**
   * Registra o agendador quando `ASSOCIADO_SORTE_AGENDADOR=true`. Desligado
   * (padrão), remove o agendador que tenha ficado no Redis e não loga nada:
   * nenhum lembrete, apuração ou alerta roda. Falha aqui não derruba o boot.
   */
  async onModuleInit(): Promise<void> {
    const config = associadoSorteConfig();
    if (!config.agendadorAtivo) {
      // Silencioso: só garante que nenhum agendador antigo continue rodando.
      await this.fila
        .removeJobScheduler(SORTE_CICLO_SCHEDULER_ID)
        .catch(() => undefined);
      return;
    }
    try {
      await this.fila.upsertJobScheduler(
        SORTE_CICLO_SCHEDULER_ID,
        { every: config.cicloIntervaloMs },
        {
          name: SORTE_CICLO_JOB,
          opts: { removeOnComplete: true, removeOnFail: 20 },
        },
      );
      this.logger.log(
        `Ciclo do Associado da Sorte agendado a cada ${config.cicloIntervaloMs / 1000}s`,
      );
    } catch (erro) {
      this.logger.warn(
        `Não foi possível configurar o ciclo do Associado da Sorte: ${(erro as Error).message}`,
      );
    }
  }

  /**
   * Uma execução: apura sorteios vencidos, encerra corridas e vitrines
   * vencidas ou esgotadas e dispara os lembretes pendentes. Cada etapa é
   * idempotente e isolada: a falha de uma rodada não trava as outras.
   */
  async executar(agora: Date = new Date()): Promise<CicloResultado> {
    let sorteiosApurados = 0;
    for (const rodadaId of await this.rodadasRepository.listarSorteiosVencidos(
      agora,
    )) {
      try {
        await this.rodadasRepository.marcarApurando(rodadaId);
        const r = await this.apuracao.apurar(rodadaId, 'JOB');
        if (!r.jaApurada) sorteiosApurados++;
      } catch (erro) {
        this.logger.error(
          `Falha ao apurar o sorteio #${rodadaId}: ${(erro as Error).message}`,
        );
      }
    }

    let rodadasEncerradas = 0;
    try {
      rodadasEncerradas =
        await this.rodadasRepository.encerrarCorridasEResgates(agora);
      if (rodadasEncerradas > 0) {
        this.logger.log(
          `${rodadasEncerradas} rodada(s) de corrida/vitrine encerrada(s)`,
        );
      }
    } catch (erro) {
      this.logger.error(
        `Falha ao encerrar corridas/vitrines: ${(erro as Error).message}`,
      );
    }

    const lembretesEnfileirados =
      await this.notificacoes.enviarLembretes(agora);

    // v2: campanhas cujo período acabou.
    let campanhasEncerradas = 0;
    try {
      campanhasEncerradas = await this.campanhas.encerrarVencidas(agora);
    } catch (erro) {
      this.logger.error(
        `Falha ao encerrar campanhas vencidas: ${(erro as Error).message}`,
      );
    }

    // v2: "Sua raspadinha está liberada".
    let lembretesRaspadaEnfileirados = 0;
    try {
      lembretesRaspadaEnfileirados = await this.lembreteRaspada.enviar(agora);
    } catch (erro) {
      this.logger.error(
        `Falha nos lembretes de raspadinha: ${(erro as Error).message}`,
      );
    }

    return {
      sorteiosApurados,
      rodadasEncerradas,
      lembretesEnfileirados,
      campanhasEncerradas,
      lembretesRaspadaEnfileirados,
    };
  }
}

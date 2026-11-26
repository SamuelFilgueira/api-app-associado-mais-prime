import { Injectable, Logger } from '@nestjs/common';
import { metricas } from 'src/infra/observability/metricas';
import { TravaService } from 'src/infra/redis/trava.service';
import {
  DISPARO_PARADO_MS,
  DISPARO_VALIDADE_MS,
} from 'src/notifications/domain/push-disparo';
import {
  DisparoPush,
  PushDisparoRepository,
} from 'src/notifications/repositories/push-disparo.repository';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { PushDisparoService } from 'src/notifications/services/push-disparo.service';
import { PushLoteService } from 'src/notifications/services/push-lote.service';

/** Disparos parados tratados por rodada. */
const MAX_POR_RODADA = 50;
/** Trava da rodada: duas varreduras nunca correm juntas. */
const TRAVA_DA_VARREDURA_MS = 5 * 60_000;

export interface ResultadoDaVarredura {
  /** Agendamentos com o despertador garantido nesta rodada. */
  agendados: number;
  /** Agendamentos fechados como falhos por terem passado da tolerância. */
  perdidos: number;
  /** Logs abertos sem disparo, fechados como falhos. */
  logsOrfaos: number;
  /** Disparos parados que voltaram a andar. */
  retomados: number;
  /** Disparos parados que foram fechados (concluídos, vencidos ou falhos). */
  encerrados: number;
  /** Idade, em segundos, do disparo mais antigo ainda aberto. */
  idadeDoMaisAntigoSeg: number;
}

/**
 * Varredura periódica do push em massa (só no papel `worker`). Substitui a
 * reconciliação que só rodava no boot:
 *
 *  1. recria o despertador dos agendamentos pendentes;
 *  2. fecha como falho o log que ficou aberto sem disparo;
 *  3. retoma o disparo sem batimento há mais de 15 minutos — termina a
 *     criação ou recoloca os lotes na fila — e fecha o que venceu;
 *  4. publica a idade do disparo mais antigo ainda em envio.
 */
@Injectable()
export class PushVarreduraService {
  private readonly logger = new Logger(PushVarreduraService.name);

  constructor(
    private readonly repo: PushDisparoRepository,
    private readonly disparos: PushDisparoService,
    private readonly lotes: PushLoteService,
    private readonly agendamento: MarketingAgendamentoService,
    private readonly trava: TravaService,
  ) {}

  /** `null` quando outra instância já está varrendo. */
  async executar(
    agora: Date = new Date(),
  ): Promise<ResultadoDaVarredura | null> {
    const rodada = await this.trava.tentar(
      'push-massa:varredura',
      TRAVA_DA_VARREDURA_MS,
      () => this.varrer(agora),
    );
    return rodada.executou ? rodada.valor : null;
  }

  private async varrer(agora: Date): Promise<ResultadoDaVarredura> {
    const { agendados, perdidos } =
      await this.agendamento.reconciliarPendentes(agora);

    const limite = new Date(agora.getTime() - DISPARO_PARADO_MS);
    const logsOrfaos = await this.repo.falharLogsOrfaos(limite, agora);

    let retomados = 0;
    let encerrados = 0;
    const falhas: string[] = [];
    for (const disparo of await this.repo.disparosParados(
      limite,
      MAX_POR_RODADA,
    )) {
      // De duas varreduras, só a que marcar o batimento retoma.
      if (!(await this.repo.reivindicarRetomada(disparo, agora))) continue;
      try {
        if ((await this.retomar(disparo, agora)) === 'retomado') retomados++;
        else encerrados++;
      } catch (erro) {
        // Um disparo que não retoma não impede os outros; a rodada termina
        // e FALHA no fim, com todos os que ficaram para trás.
        falhas.push(
          `#${disparo.id}: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }

    const inicio = await this.repo.inicioDoMaisAntigoAberto();
    const idadeDoMaisAntigoSeg = inicio
      ? Math.max(0, Math.round((agora.getTime() - inicio.getTime()) / 1000))
      : 0;
    metricas.marketingEmEnvioIdade.set(idadeDoMaisAntigoSeg);

    if (logsOrfaos || retomados || encerrados || perdidos) {
      this.logger.warn(
        `[PUSH] varredura: ${retomados} disparo(s) retomado(s), ${encerrados} encerrado(s), ${logsOrfaos} log(s) sem disparo fechado(s), ${perdidos} agendamento(s) com horário perdido`,
      );
    }
    if (falhas.length > 0) {
      throw new Error(
        `Varredura do push: ${falhas.length} disparo(s) não retomado(s) — ${falhas.join('; ')}`,
      );
    }
    return {
      agendados,
      perdidos,
      logsOrfaos,
      retomados,
      encerrados,
      idadeDoMaisAntigoSeg,
    };
  }

  private async retomar(
    disparo: DisparoPush,
    agora: Date,
  ): Promise<'retomado' | 'encerrado'> {
    const vencido =
      agora.getTime() - disparo.criadoEm.getTime() > DISPARO_VALIDADE_MS;

    if (disparo.estado === 'CRIADO') {
      // A seleção do marketing pode ser refeita; a lista da planilha se
      // perdeu com a requisição. Em `CRIADO` nenhum push saiu.
      if (vencido || disparo.tipo !== 'MARKETING') {
        await this.repo.falharCriacao(
          disparo.id,
          'Criação do disparo interrompida; nenhum push foi enviado.',
          agora,
        );
        return 'encerrado';
      }
      await this.disparos.popularEIniciar(
        disparo,
        this.disparos.fonteDeMarketing(),
      );
      return 'retomado';
    }

    if (vencido) await this.repo.expirarAbertas(disparo.id);
    if (await this.lotes.tentarFechar(disparo.id, agora)) return 'encerrado';

    // O sufixo muda a cada retomada: os jobs originais podem estar no Redis
    // como falhos, e o BullMQ ignoraria um job novo com o mesmo id.
    const lotes = await this.disparos.enfileirarLotes(
      disparo.id,
      Math.floor(agora.getTime() / 1000),
    );
    return lotes > 0 ? 'retomado' : 'encerrado';
  }
}

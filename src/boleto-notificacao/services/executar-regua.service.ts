import { Injectable, Logger } from '@nestjs/common';
import { ResultadoDaTrava, TravaService } from 'src/infra/redis/trava.service';
import { formatDateBR, formatDateISO, startOfDay } from 'src/shared/date.util';
import { baseTag } from 'src/shared/log.util';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { janelaDaEtapa } from 'src/boleto-notificacao/domain/regua-janelas';
import {
  ContextoDaRegua,
  MotivoDoPulo,
  resultadoDaEtapa,
  ResultadoMomento,
} from 'src/boleto-notificacao/domain/regua-resultado';
import {
  TIPOS_MENSAGEM,
  TipoMensagem,
} from 'src/boleto-notificacao/domain/regua-tipos';
import { ReguaDaBaseService } from 'src/boleto-notificacao/services/regua-da-base.service';
import { ReguaMetricaService } from 'src/boleto-notificacao/services/regua-metrica.service';

export interface ExecutarRotinaOptions {
  dataReferencia?: Date;
  tenants?: string[];
  tipos?: TipoMensagem[];
  dryRun?: boolean;
  origem?: 'AGENDADA' | 'MANUAL';
  /**
   * Bases que o MESMO job já fechou para esta data numa tentativa anterior:
   * o retry não repete a varredura do SGA delas.
   */
  basesJaConcluidas?: string[];
}

/**
 * O que fazer quando outra execução segura a trava da base:
 *  - `aguardar`: espera o tempo de uma trava sem dono expirar (o processo
 *    que a segurava pode ter morrido) e só então desiste. Para jobs.
 *  - `desistir`: devolve na hora. Para a rota síncrona do painel.
 */
export type AoEncontrarTrava = 'aguardar' | 'desistir';

/**
 * TTL da trava. Ela é renovada a cada terço disso enquanto a régua roda;
 * se o processo morre, a base fica presa por no máximo este tempo.
 */
export const TTL_DA_TRAVA_MS = 90_000;
/** Intervalo entre as tentativas de quem está aguardando a trava. */
export const INTERVALO_DE_ESPERA_MS = 15_000;
/** Tentativas no modo `aguardar`: cobre o TTL inteiro, com folga. */
export const TENTATIVAS_DE_TRAVA =
  Math.ceil(TTL_DA_TRAVA_MS / INTERVALO_DE_ESPERA_MS) + 2;

/**
 * Chave da trava: base + data de referência. É a granularidade em que a
 * rotina trabalha — UMA varredura do SGA por base e dia alimenta as seis
 * etapas. Travar por etapa deixaria duas varreduras da mesma base rodarem
 * juntas (manual só com D0 + agendada completa), que é o que a Hinova pune.
 */
export function chaveDaTrava(tenant: string, dataReferencia: Date): string {
  return `boleto-regua:${tenant}:${formatDateISO(dataReferencia)}`;
}

/**
 * Caso de uso: executar a régua para as bases pedidas. Cada base roda
 * isolada, sob a própria trava: uma base fora (SGA bloqueado, erro
 * inesperado) vira resultado `FALHA` e não impede as outras.
 *
 * Nunca lança por falha de base — devolve os resultados por etapa. Quem
 * decide repetir (o job) lê esses resultados com `avaliarRegua`.
 */
@Injectable()
export class ExecutarReguaService {
  private readonly logger = new Logger(ExecutarReguaService.name);

  constructor(
    private readonly configService: BoletoNotificacaoConfigService,
    private readonly reguaDaBase: ReguaDaBaseService,
    private readonly trava: TravaService,
    private readonly metrica: ReguaMetricaService,
  ) {}

  async executar(
    options: ExecutarRotinaOptions = {},
    aoEncontrarTrava: AoEncontrarTrava = 'aguardar',
  ): Promise<ResultadoMomento[]> {
    const config = this.configService.get();
    const contexto: ContextoDaRegua = {
      dataReferencia: startOfDay(options.dataReferencia ?? new Date()),
      tipos: options.tipos?.length ? options.tipos : TIPOS_MENSAGEM,
      dryRun: options.dryRun === true,
      origem: options.origem ?? 'MANUAL',
    };
    const tenants = options.tenants?.length ? options.tenants : config.tenants;
    const jaConcluidas = new Set(options.basesJaConcluidas ?? []);

    this.logger.log(
      `[BOLETO-NOTIF] ▶ Rotina iniciada: referencia=${formatDateBR(contexto.dataReferencia)} tenants=[${tenants.join(',')}] tipos=[${contexto.tipos.join(',')}] dryRun=${contexto.dryRun} origem=${contexto.origem}`,
    );

    const resultados: ResultadoMomento[] = [];
    for (const tenant of tenants) {
      if (jaConcluidas.has(tenant)) {
        this.logger.log(
          `[BOLETO-NOTIF]${baseTag(tenant)} já concluída por este job numa tentativa anterior — não repete a varredura`,
        );
        resultados.push(...this.pular(tenant, contexto, 'JA_CONCLUIDA'));
        continue;
      }
      resultados.push(
        ...(await this.executarBase(tenant, contexto, aoEncontrarTrava)),
      );
    }

    const enviados = resultados.reduce(
      (acc, r) => acc + r.metricas.totalEnviados,
      0,
    );
    this.logger.log(
      `[BOLETO-NOTIF] ■ Rotina concluída: ${resultados.length} momento(s), ${enviados} push(es) enviados`,
    );

    return resultados;
  }

  /** Uma base, sob a trava dela, sem deixar a falha escapar para as outras. */
  private async executarBase(
    tenant: string,
    contexto: ContextoDaRegua,
    aoEncontrarTrava: AoEncontrarTrava,
  ): Promise<ResultadoMomento[]> {
    let rodada: ResultadoDaTrava<ResultadoMomento[]>;
    try {
      rodada = await this.comTrava(
        chaveDaTrava(tenant, contexto.dataReferencia),
        aoEncontrarTrava,
        () => this.reguaDaBase.executar(tenant, contexto),
      );
    } catch (erro) {
      // Falha fora das etapas (trava sem Redis, banco fora ao registrar a
      // falha da consulta): a base sai como FALHA e o job repete.
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      this.logger.error(
        `[BOLETO-NOTIF]${baseTag(tenant)} ❌ régua da base interrompida: ${mensagem}`,
        erro instanceof Error ? erro.stack : undefined,
      );
      return this.semExecucao(tenant, contexto, {
        status: 'FALHA',
        erro: mensagem,
      });
    }

    if (!rodada.executou) {
      this.logger.warn(
        `[BOLETO-NOTIF]${baseTag(tenant)} já existe uma execução da régua em curso para ${formatDateBR(contexto.dataReferencia)} — base pulada`,
      );
      return this.pular(tenant, contexto, 'EXECUCAO_EM_CURSO');
    }

    const resultados = rodada.valor;
    if (
      !contexto.dryRun &&
      resultados.length > 0 &&
      resultados.every((r) => r.status === 'CONCLUIDA')
    ) {
      this.metrica.registrarConclusao(tenant);
    }
    return resultados;
  }

  private pular(
    tenant: string,
    contexto: ContextoDaRegua,
    motivoDoPulo: MotivoDoPulo,
  ): ResultadoMomento[] {
    return this.semExecucao(tenant, contexto, {
      status: 'PULADA',
      motivoDoPulo,
    });
  }

  /** Um resultado por etapa pedida, para a base que não chegou a rodar. */
  private semExecucao(
    tenant: string,
    contexto: ContextoDaRegua,
    desfecho: Pick<ResultadoMomento, 'status' | 'erro' | 'motivoDoPulo'>,
  ): ResultadoMomento[] {
    const regras = this.configService.get();
    return contexto.tipos.map((tipo) =>
      resultadoDaEtapa(
        tenant,
        tipo,
        contexto,
        janelaDaEtapa(contexto.dataReferencia, tipo, regras),
        desfecho,
      ),
    );
  }

  /**
   * Tenta a trava. No modo `aguardar`, insiste pelo tempo de uma trava sem
   * dono expirar: depois de um restart no meio da régua, o job reexecutado
   * encontraria a trava do processo morto e concluiria sem fazer nada —
   * perdendo as etapas de dia único. Se o dono está vivo (renovando), a
   * espera termina sem a trava e a base é pulada.
   */
  private async comTrava<T>(
    chave: string,
    aoEncontrarTrava: AoEncontrarTrava,
    fn: () => Promise<T>,
  ): Promise<ResultadoDaTrava<T>> {
    const tentativas =
      aoEncontrarTrava === 'aguardar' ? TENTATIVAS_DE_TRAVA : 1;
    for (let tentativa = 1; ; tentativa++) {
      const resultado = await this.trava.tentar(chave, TTL_DA_TRAVA_MS, fn);
      if (resultado.executou || tentativa >= tentativas) return resultado;
      await this.aguardar(INTERVALO_DE_ESPERA_MS);
    }
  }

  /** Espera entre tentativas de trava; separado para ser trocado em teste. */
  protected aguardar(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

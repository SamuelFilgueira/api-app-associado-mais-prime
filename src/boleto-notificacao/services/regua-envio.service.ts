import { Injectable, Logger } from '@nestjs/common';
import { ExpoPushClient } from 'src/integrations/expo/expo-push.client';
import {
  PushGateway,
  ResultadoPush,
  tokenMorto,
} from 'src/integrations/expo/push.gateway';
import { Destinatario } from 'src/boleto-notificacao/domain/regua-elegibilidade';
import {
  descreverFalhaDeTransporte,
  descreverRecusa,
  fatiar,
} from 'src/boleto-notificacao/domain/regua-envio';
import { montarPush } from 'src/boleto-notificacao/domain/regua-mensagens';
import { MetricasMomento } from 'src/boleto-notificacao/domain/regua-resultado';
import {
  ItemDoHistorico,
  ReguaDestinatarioRepository,
} from 'src/boleto-notificacao/repositories/regua-destinatario.repository';
import {
  ContextoDoLog,
  ReguaLogRepository,
} from 'src/boleto-notificacao/repositories/regua-log.repository';

/** Limite de mensagens por requisição ao Expo. */
export const TAMANHO_DO_LOTE = 100;

/** Rótulo `tipo` da métrica `push_enviados_total`. */
const TIPO_DA_METRICA = 'boleto_regua';

/** Envio reservado: o log `ENFILEIRADO` desta execução e o seu destinatário. */
interface Reserva {
  logId: number;
  destinatario: Destinatario;
}

export interface EntradaDoEnvio extends ContextoDoLog {
  /** Prefixo de log da etapa. */
  tag: string;
  destinatarios: Destinatario[];
}

/**
 * Caso de uso: enviar e registrar. Para cada lote de até 100 destinatários:
 * reserva os logs (`ENFILEIRADO`), envia pelo `PushGateway` e grava o
 * desfecho de cada um ANTES de passar ao próximo lote — se o processo cair,
 * no máximo um lote fica sem desfecho, e a próxima execução o retoma.
 *
 * Lote que fica sem resposta do Expo ganha uma segunda rodada no fim; o que
 * continuar sem resposta sai como pendente (`totalPendentes`).
 */
@Injectable()
export class ReguaEnvioService {
  private readonly logger = new Logger(ReguaEnvioService.name);

  constructor(
    private readonly logs: ReguaLogRepository,
    private readonly destinatarios: ReguaDestinatarioRepository,
    private readonly push: PushGateway,
  ) {}

  /** Atualiza `metricas` conforme avança, para a falha no meio não perdê-las. */
  async enviar(
    entrada: EntradaDoEnvio,
    metricas: MetricasMomento,
  ): Promise<void> {
    if (entrada.destinatarios.length === 0) return;

    let lotes = 0;
    const semResposta: Reserva[] = [];
    for (const lote of fatiar(entrada.destinatarios, TAMANHO_DO_LOTE)) {
      const reservas = await this.reservar(lote, entrada, metricas);
      semResposta.push(...(await this.despachar(reservas, entrada, metricas)));
      lotes++;
    }

    // Segunda rodada: só o que ficou sem resposta do Expo.
    const pendentes: Reserva[] = [];
    for (const lote of fatiar(semResposta, TAMANHO_DO_LOTE)) {
      const reservas = await this.retomarSemResposta(lote, entrada.execucaoId);
      pendentes.push(...(await this.despachar(reservas, entrada, metricas)));
      lotes++;
    }
    metricas.totalFalhas += pendentes.length;
    metricas.totalPendentes += pendentes.length;

    this.logger.log(
      `${entrada.tag} envio concluído: ${metricas.totalEnviados} enviados, ${metricas.totalFalhas} falhas, ${metricas.totalTokensInvalidos} tokens inválidos (${lotes} lote(s))`,
    );
  }

  /**
   * Grava (ou assume) o log de cada destinatário do lote. Quem perde a
   * corrida para outra execução — unique de idempotência ou retomada que não
   * pegou — sai do lote como idempotente.
   */
  private async reservar(
    lote: Destinatario[],
    contexto: ContextoDoLog,
    metricas: MetricasMomento,
  ): Promise<Reserva[]> {
    const reservas: Reserva[] = [];
    for (const destinatario of lote) {
      const log = destinatario.logParaRetomar;
      if (log) {
        if (await this.logs.retomar(contexto, destinatario, log)) {
          reservas.push({ logId: log.id, destinatario });
          metricas.totalReenvios++;
        } else {
          metricas.totalIdempotentes++;
        }
        continue;
      }
      const logId = await this.logs.criar(contexto, destinatario);
      if (logId === null) {
        metricas.totalIdempotentes++; // outra execução concorrente já registrou
      } else {
        reservas.push({ logId, destinatario });
      }
    }
    metricas.totalEnfileirados += reservas.length;
    return reservas;
  }

  /** Falhas de transporte desta execução voltam a `ENFILEIRADO`. */
  private async retomarSemResposta(
    lote: Reserva[],
    execucaoId: number,
  ): Promise<Reserva[]> {
    const reservas: Reserva[] = [];
    for (const reserva of lote) {
      if (await this.logs.retomarFalhaDeTransporte(reserva.logId, execucaoId)) {
        reservas.push(reserva);
      }
    }
    return reservas;
  }

  /**
   * Envia um lote já reservado e grava o desfecho de cada push. O gateway
   * devolve um resultado por mensagem, na ordem enviada: `reservas[i]`
   * corresponde a `resultados[i]`. Devolve as reservas que ficaram sem
   * resposta do Expo (falha de transporte).
   */
  private async despachar(
    reservas: Reserva[],
    entrada: EntradaDoEnvio,
    metricas: MetricasMomento,
  ): Promise<Reserva[]> {
    if (reservas.length === 0) return [];

    const mensagens = reservas.map(({ destinatario }) =>
      montarPush(destinatario, entrada.tipo),
    );
    const resultados: Array<ResultadoPush | undefined> =
      await this.push.enviar(mensagens);
    ExpoPushClient.contar(
      TIPO_DA_METRICA,
      resultados.filter((r): r is ResultadoPush => !!r),
    );

    const historico: ItemDoHistorico[] = [];
    const semResposta = new Map<string, Reserva[]>();

    for (let i = 0; i < reservas.length; i++) {
      const reserva = reservas[i];
      const { destinatario, logId } = reserva;
      // Sem resultado na posição: trata como "sem resposta", nunca como o
      // resultado de outra mensagem.
      const resultado: ResultadoPush = resultados[i] ?? {
        status: 'falha_transporte',
        mensagem: 'gateway não devolveu resultado para a mensagem',
      };

      if (resultado.status === 'ok') {
        metricas.totalEnviados++;
        const registrado = await this.logs.marcarEnviado(
          logId,
          entrada.execucaoId,
          resultado.ticketId ?? null,
        );
        if (!registrado) {
          this.logger.warn(
            `${entrada.tag} log #${logId} deixou de ser desta execução durante o envio; o ticket não foi gravado`,
          );
        }
        historico.push({
          userId: destinatario.userId,
          expoPushToken: destinatario.expoPushToken,
          title: destinatario.titulo,
          body: destinatario.corpo,
          data: mensagens[i].data,
        });
        continue;
      }

      if (resultado.status === 'recusado') {
        const descricao = descreverRecusa(
          resultado.detalhe,
          resultado.mensagem,
          'TICKET_ERROR',
        );
        metricas.totalFalhas++;
        await this.logs.marcarFalhaDeEnvio(
          [logId],
          entrada.execucaoId,
          descricao,
        );
        if (tokenMorto(resultado)) {
          metricas.totalTokensInvalidos++;
          await this.invalidarToken(destinatario, entrada.tag);
        }
        this.logger.warn(
          `${entrada.tag} ticket com erro para user ${destinatario.userId}: ${descricao}`,
        );
        continue;
      }

      const descricao = descreverFalhaDeTransporte(resultado.mensagem);
      semResposta.set(descricao, [
        ...(semResposta.get(descricao) ?? []),
        reserva,
      ]);
    }

    for (const [descricao, lista] of semResposta) {
      this.logger.error(
        `${entrada.tag} ${lista.length} push(es) sem resposta do Expo: ${descricao}`,
      );
      await this.logs.marcarFalhaDeEnvio(
        lista.map((r) => r.logId),
        entrada.execucaoId,
        descricao,
      );
    }

    await this.destinatarios.gravarHistorico(historico);

    return Array.from(semResposta.values()).flat();
  }

  private async invalidarToken(
    destinatario: Destinatario,
    tag: string,
  ): Promise<void> {
    const removido = await this.destinatarios.invalidarToken(
      destinatario.userId,
      destinatario.expoPushToken,
    );
    this.logger.warn(
      removido
        ? `${tag} token do user ${destinatario.userId} marcado como inválido (DeviceNotRegistered) e removido`
        : `${tag} token do user ${destinatario.userId} recusado como inválido, mas o cadastro já está com outro token`,
    );
  }
}

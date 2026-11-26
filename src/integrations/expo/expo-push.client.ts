import { Injectable, Logger } from '@nestjs/common';
import {
  Expo,
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushTicket,
} from 'expo-server-sdk';
import { medirVendor, metricas } from 'src/infra/observability/metricas';
import {
  MensagemPush,
  PushGateway,
  ReciboPush,
  ResultadoPush,
} from 'src/integrations/expo/push.gateway';

/** Prazo de cada chamada ao Expo. O SDK não tem timeout próprio. */
export const EXPO_PRAZO_MS = 20_000;

/**
 * Adaptador do Expo Push. Um por processo (antes havia quatro `new Expo()`
 * espalhados pelos services).
 *
 * O que ele acrescenta ao SDK:
 *  - prazo por chamada: sem ele, um Expo pendurado segurava o job e a fila;
 *  - resultado por mensagem, alinhado à entrada — a conta de "qual ticket é
 *    de qual destinatário" fica aqui, num lugar só;
 *  - lote que falha não derruba os demais: as mensagens dele voltam como
 *    `falha_transporte` e os outros lotes seguem;
 *  - métricas de chamada e de resultado.
 */
@Injectable()
export class ExpoPushClient extends PushGateway {
  private readonly logger = new Logger(ExpoPushClient.name);
  private readonly expo = new Expo();

  tokenValido(token: unknown): token is string {
    return Expo.isExpoPushToken(token);
  }

  async enviar(mensagens: MensagemPush[]): Promise<ResultadoPush[]> {
    const resultados: ResultadoPush[] = new Array<ResultadoPush>(
      mensagens.length,
    );
    const lotes = this.expo.chunkPushNotifications(
      mensagens as ExpoPushMessage[],
    );
    let inicio = 0;

    for (const lote of lotes) {
      const deslocamento = inicio;
      inicio += lote.length;

      try {
        const tickets = await medirVendor(
          { vendor: 'expo', operacao: 'push_send' },
          () => comPrazo(this.expo.sendPushNotificationsAsync(lote)),
          classificar,
        );
        lote.forEach((_mensagem, i) => {
          resultados[deslocamento + i] = paraResultado(tickets[i]);
        });
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        this.logger.warn(
          `Lote de ${lote.length} push(es) sem resposta do Expo: ${mensagem}`,
        );
        lote.forEach((_mensagem, i) => {
          resultados[deslocamento + i] = {
            status: 'falha_transporte',
            mensagem,
          };
        });
      }
    }

    return resultados;
  }

  async consultarRecibos(
    ticketIds: string[],
  ): Promise<Record<string, ReciboPush>> {
    const recibos: Record<string, ReciboPush> = {};

    for (const lote of this.expo.chunkPushNotificationReceiptIds(ticketIds)) {
      const resposta = await medirVendor(
        { vendor: 'expo', operacao: 'push_receipts' },
        () => comPrazo(this.expo.getPushNotificationReceiptsAsync(lote)),
        classificar,
      );
      for (const [id, recibo] of Object.entries(resposta)) {
        recibos[id] = paraRecibo(recibo);
      }
    }
    return recibos;
  }

  /** Conta o desfecho de um envio na métrica de negócio. */
  static contar(tipo: string, resultados: ResultadoPush[]): void {
    for (const resultado of resultados) {
      metricas.pushEnviados.inc({
        tipo,
        resultado:
          resultado.status === 'ok'
            ? 'ok'
            : resultado.status === 'recusado' &&
                resultado.detalhe === 'DeviceNotRegistered'
              ? 'token_invalido'
              : 'erro',
      });
    }
  }
}

function paraResultado(ticket: ExpoPushTicket | undefined): ResultadoPush {
  if (!ticket) {
    return { status: 'falha_transporte', mensagem: 'Expo não devolveu ticket' };
  }
  if (ticket.status === 'ok') return { status: 'ok', ticketId: ticket.id };
  return {
    status: 'recusado',
    mensagem: ticket.message,
    detalhe: ticket.details?.error,
  };
}

function paraRecibo(recibo: ExpoPushReceipt): ReciboPush {
  if (recibo.status === 'ok') return { status: 'ok' };
  return {
    status: 'erro',
    mensagem: recibo.message,
    detalhe: recibo.details?.error,
  };
}

class PrazoDoExpoEsgotado extends Error {
  readonly code = 'ETIMEDOUT';
  constructor() {
    super(`Expo não respondeu em ${EXPO_PRAZO_MS / 1000}s`);
  }
}

function comPrazo<T>(promessa: Promise<T>): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const prazo = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(
      () => rejeitar(new PrazoDoExpoEsgotado()),
      EXPO_PRAZO_MS,
    );
  });
  return Promise.race([promessa, prazo]).finally(() => {
    if (temporizador) clearTimeout(temporizador);
  });
}

function classificar(erro: unknown): 'erro' | 'timeout' {
  return erro instanceof PrazoDoExpoEsgotado ? 'timeout' : 'erro';
}

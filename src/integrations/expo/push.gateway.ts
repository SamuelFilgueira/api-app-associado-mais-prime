/**
 * Porta de envio de push. Os services dependem desta classe abstrata (que
 * também é o token de injeção), e não do SDK do Expo: nos testes entra um
 * fake em memória, e trocar de provedor não toca nas regras.
 */

export interface MensagemPush {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
  badge?: number;
  ttl?: number;
  /** iOS: acorda o app em segundo plano para tratar o push. */
  _contentAvailable?: boolean;
  /** iOS: permite que a extensão de notificação altere o conteúdo. */
  mutableContent?: boolean;
}

/**
 * Resultado do envio de UMA mensagem, na mesma posição da mensagem enviada.
 *
 * - `ok`: o provedor aceitou; `ticketId` serve para consultar o recibo.
 * - `recusado`: o provedor respondeu que não vai entregar. `detalhe` traz o
 *   motivo dele (`DeviceNotRegistered` = token morto, pode ser apagado).
 * - `falha_transporte`: a chamada não chegou a uma resposta (rede, timeout,
 *   5xx). Nada se sabe sobre a entrega: é o único caso que vale repetir.
 */
export type ResultadoPush =
  | { status: 'ok'; ticketId?: string }
  | { status: 'recusado'; mensagem: string; detalhe?: string }
  | { status: 'falha_transporte'; mensagem: string };

export type ReciboPush =
  | { status: 'ok' }
  | { status: 'erro'; mensagem: string; detalhe?: string };

export abstract class PushGateway {
  /** O token tem formato de token de push do provedor? */
  abstract tokenValido(token: unknown): token is string;

  /**
   * Envia as mensagens em lotes e devolve um resultado por mensagem, na
   * ordem recebida. Nunca lança por falha de envio: a falha vem no resultado
   * de cada mensagem atingida, para o chamador repetir só essas.
   */
  abstract enviar(mensagens: MensagemPush[]): Promise<ResultadoPush[]>;

  /** Recibos de entrega por id de ticket (só os que o provedor devolver). */
  abstract consultarRecibos(
    ticketIds: string[],
  ): Promise<Record<string, ReciboPush>>;
}

/** O provedor disse que o aparelho não recebe mais push neste token. */
export function tokenMorto(resultado: ResultadoPush | ReciboPush): boolean {
  return (
    (resultado.status === 'recusado' || resultado.status === 'erro') &&
    resultado.detalhe === 'DeviceNotRegistered'
  );
}

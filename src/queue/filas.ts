import type { DefaultJobOptions, JobsOptions } from 'bullmq';

/**
 * Nomes das filas e política de retry de cada uma.
 *
 * Padrão da casa: 5 tentativas com backoff exponencial a partir de 2 s e
 * jitter. Uma fila só foge dele com o motivo escrito ao lado.
 *
 * Regras que valem para todo job:
 *  - o payload carrega `baseOrigin` e `_meta` (ver `job-envelope.ts`);
 *  - o handler é idempotente pela chave de negócio: entrega duplicada é
 *    assumida (job "stalled" reexecuta, retry reentrega);
 *  - nenhuma fila depende de ordem;
 *  - job que esgota as tentativas, ou falha com erro definitivo, vai para a
 *    fila de mortos (`FILA_DE_MORTOS`) e dispara alerta.
 */
export const WEBHOOK_QUEUE = 'webhook-events';
export const NOTIFICATION_QUEUE = 'notifications';
export const FUEL_ECONOMY_QUEUE = 'fuel-economy';
export const BOLETO_VERIFICACAO_QUEUE = 'boleto-verificacao';
export const ANALYTICS_QUEUE = 'analytics-summaries';
export const BOLETO_NOTIFICACAO_QUEUE = 'boleto-notificacao';
/** Retry da criação do boleto de reativação após instabilidade do SGA. */
export const BOLETO_REATIVACAO_RETRY_QUEUE = 'boleto-reativacao-retry';
/** Disparos de push de marketing agendados (job atrasado até a data/hora). */
export const MARKETING_AGENDADA_QUEUE = 'marketing-agendada';
/** Job periódico do Associado da Sorte (apuração, encerramento, lembretes). */
export const ASSOCIADO_SORTE_QUEUE = 'associado-sorte';
/** Renderização de PDF (Chromium): consumida só pelo processo `pdf`. */
export const PDF_QUEUE = 'pdf-render';
/** Push em massa, um job por lote de destinatários. */
export const PUSH_MASSA_QUEUE = 'push-massa';
/** Despacho do outbox (eventos gravados na mesma transação do fato). */
export const OUTBOX_QUEUE = 'outbox';
/** Varreduras e expurgos periódicos (retenção, reconciliação). */
export const MANUTENCAO_QUEUE = 'manutencao';
/**
 * Fila de mortos. Ninguém a consome: os jobs ficam parados até alguém
 * reprocessar ou descartar pelo painel (`/api/admin/filas`).
 */
export const FILA_DE_MORTOS = 'fila-de-mortos';

export const FILAS = [
  WEBHOOK_QUEUE,
  NOTIFICATION_QUEUE,
  FUEL_ECONOMY_QUEUE,
  BOLETO_VERIFICACAO_QUEUE,
  ANALYTICS_QUEUE,
  BOLETO_NOTIFICACAO_QUEUE,
  BOLETO_REATIVACAO_RETRY_QUEUE,
  MARKETING_AGENDADA_QUEUE,
  ASSOCIADO_SORTE_QUEUE,
  PDF_QUEUE,
  PUSH_MASSA_QUEUE,
  OUTBOX_QUEUE,
  MANUTENCAO_QUEUE,
] as const;

export type NomeDaFila = (typeof FILAS)[number];

/** Retry padrão: 2 s, 4 s, 8 s, 16 s (±50% de jitter), 5 tentativas. */
export const RETRY_PADRAO: Pick<JobsOptions, 'attempts' | 'backoff'> = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 },
};

/**
 * Retenção no Redis. Falhos ficam 7 dias (a cópia de trabalho vai para a
 * fila de mortos; esta é só o histórico curto para diagnóstico).
 */
const RETENCAO: Pick<DefaultJobOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 7 * 86_400, count: 5_000 },
};

/**
 * Opções padrão por fila. As do `queue.add(...)` de cada chamada continuam
 * prevalecendo sobre estas.
 *
 * Fila cujo handler já é idempotente usa o `RETRY_PADRAO`. As demais ficam
 * só com a retenção: enquanto o handler puder repetir efeito (push, e-mail,
 * boleto), retry automático é entrega em dobro — a política de cada uma
 * continua no ponto de enfileiramento até o handler ser corrigido.
 */
export const OPCOES_POR_FILA: Record<NomeDaFila, DefaultJobOptions> = {
  [WEBHOOK_QUEUE]: { ...RETENCAO, ...RETRY_PADRAO },
  [NOTIFICATION_QUEUE]: { ...RETENCAO, ...RETRY_PADRAO },
  // Idempotente pelo `payloadHash` do summary (o recibo é conferido na mesma
  // transação que aplica os agregados): reentrega não soma em dobro.
  [ANALYTICS_QUEUE]: { ...RETENCAO, ...RETRY_PADRAO },
  // Cada job é UMA checagem de saldo no Clubgas; "sem variação" conclui o job
  // e agenda a próxima checagem, então só erro de verdade (Clubgas fora,
  // banco) chega ao retry. Poucas tentativas com backoff de minuto: o Clubgas
  // fora não volta em 2 s, e a sessão só vale enquanto o abastecimento é
  // recente — passar disso é expirar a sessão, não insistir.
  [FUEL_ECONOMY_QUEUE]: {
    ...RETENCAO,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
  },
  // Retry padrão para o aviso de boleto pago (evento do outbox, handler
  // idempotente). A varredura fixa `attempts: 1` no próprio agendador e os
  // repetíveis antigos carregam as opções com que foram criados.
  [BOLETO_VERIFICACAO_QUEUE]: { ...RETENCAO, ...RETRY_PADRAO },
  [ASSOCIADO_SORTE_QUEUE]: { ...RETENCAO },
  // Régua de boletos: idempotente pelo log de envio. A falha típica é vendor
  // fora (SGA bloqueado, Expo sem resposta), que 2 s de backoff não esperam:
  // 3 tentativas, a segunda 10 min depois e a terceira 20 min depois dela.
  [BOLETO_NOTIFICACAO_QUEUE]: {
    ...RETENCAO,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10 * 60_000 },
  },
  [BOLETO_REATIVACAO_RETRY_QUEUE]: { ...RETENCAO },
  [MARKETING_AGENDADA_QUEUE]: { ...RETENCAO, ...RETRY_PADRAO },
  [PUSH_MASSA_QUEUE]: { ...RETENCAO, ...RETRY_PADRAO },
  [OUTBOX_QUEUE]: { ...RETENCAO, ...RETRY_PADRAO },
  [MANUTENCAO_QUEUE]: { ...RETENCAO, ...RETRY_PADRAO },
  // Renderização é cara e o chamador está esperando: uma nova tentativa só.
  [PDF_QUEUE]: {
    removeOnComplete: { age: 300, count: 100 },
    removeOnFail: { age: 3600, count: 200 },
    attempts: 2,
    backoff: { type: 'fixed', delay: 1_000 },
  },
};

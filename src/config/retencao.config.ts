/**
 * Política de retenção por tabela (expurgo diário, fila `manutencao`).
 *
 * Tabelas de NEGÓCIO só são expurgadas se a env correspondente for definida
 * com um número de dias: apagar histórico é decisão de quem opera, e o
 * padrão é não apagar nada. `0` ou vazio = não expurga.
 *
 *  - RETENCAO_NOTIFICACOES_DIAS: `Notification` (caixa de entrada do app)
 *  - RETENCAO_WEBHOOK_EVENTOS_DIAS: `VehicleWebhookEvent` (eventos da M7)
 *  - RETENCAO_VERSAO_LOG_DIAS: `AppVersionValidationLog` (uma linha por
 *    validação de versão, inclusive anônima)
 *  - RETENCAO_ANALYTICS_RECIBOS_DIAS: `AnalyticsSummaryReceipt`. A env antiga
 *    `ANALYTICS_RECEIPTS_TTL_DAYS` existe no `.env.example` mas nunca foi
 *    lida pelo código; ela continua SEM efeito de propósito — passar a
 *    obedecê-la faria um deploy apagar recibos sem ninguém ter decidido.
 *
 * Tabelas TÉCNICAS têm padrão ligado, porque só guardam estado de trabalho:
 *  - RETENCAO_OUTBOX_DIAS (7): eventos de outbox já publicados
 *  - RETENCAO_PUSH_ENTREGAS_DIAS (90): disparos de push concluídos e suas
 *    entregas
 *  - chaves de idempotência: apagadas quando vencem (sem env)
 */
export interface RetencaoConfig {
  notificacoesDias: number;
  webhookEventosDias: number;
  versaoLogDias: number;
  analyticsRecibosDias: number;
  outboxDias: number;
  pushEntregasDias: number;
}

function dias(valor: string | undefined, padrao: number): number {
  const n = Number(valor);
  if (valor === undefined || valor.trim() === '' || !Number.isFinite(n)) {
    return padrao;
  }
  return Math.min(3_650, Math.max(0, Math.trunc(n)));
}

export function retencaoConfig(
  env: NodeJS.ProcessEnv = process.env,
): RetencaoConfig {
  return {
    notificacoesDias: dias(env.RETENCAO_NOTIFICACOES_DIAS, 0),
    webhookEventosDias: dias(env.RETENCAO_WEBHOOK_EVENTOS_DIAS, 0),
    versaoLogDias: dias(env.RETENCAO_VERSAO_LOG_DIAS, 0),
    analyticsRecibosDias: dias(env.RETENCAO_ANALYTICS_RECIBOS_DIAS, 0),
    outboxDias: dias(env.RETENCAO_OUTBOX_DIAS, 7),
    pushEntregasDias: dias(env.RETENCAO_PUSH_ENTREGAS_DIAS, 90),
  };
}

/**
 * Dias de retenção dos eventos de jornada do analytics
 * (`ANALYTICS_JOURNEY_TTL_DAYS`; padrão 90). Valor inválido ou ≤ 0 cai no
 * padrão: a limpeza só existe com `ANALYTICS_JOURNEY_ENABLED=true`.
 */
export const JORNADA_ANALYTICS_TTL_PADRAO_DIAS = 90;

export function jornadaAnalyticsTtlDias(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const dias = Number.parseInt(env.ANALYTICS_JOURNEY_TTL_DAYS ?? '', 10);
  return dias > 0 ? dias : JORNADA_ANALYTICS_TTL_PADRAO_DIAS;
}

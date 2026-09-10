/**
 * Limites da jornada do usuário (bloco opcional `journey` + `device` do summary).
 *
 * A jornada viaja DENTRO do summary que o app já envia (background / timer de
 * 30 min) — não existe request por evento. Os limites abaixo protegem o
 * servidor sem obrigar o app a mudar a cadência de envio.
 */

/** Máximo de eventos de jornada aceitos por summary. Excedentes são descartados. */
export const MAX_JOURNEY_EVENTS = 400;

/**
 * Tolerância para o horário do evento em relação à janela do summary.
 * Eventos fora de [period_start - tol, period_end + tol] são descartados
 * (relógio do aparelho errado ou payload forjado).
 */
export const JOURNEY_TIME_TOLERANCE_MS = 5 * 60 * 1000;

/** Tipos de evento aceitos no `journey[].type`. */
export const JOURNEY_EVENT_TYPES = ['screen', 'action', 'form'] as const;
export type JourneyEventType = (typeof JOURNEY_EVENT_TYPES)[number];

/** Resultados aceitos em `journey[].outcome` (somente type=form). */
export const JOURNEY_FORM_OUTCOMES = [
  'started',
  'submitted',
  'success',
  'error',
] as const;
export type JourneyFormOutcome = (typeof JOURNEY_FORM_OUTCOMES)[number];

/** Tipos de aparelho aceitos em `device.device_type`. */
export const DEVICE_TYPES: ReadonlySet<string> = new Set([
  'phone',
  'tablet',
  'desktop',
  'tv',
  'unknown',
]);

/** Ações que marcam entrada/saída da conta no aparelho. */
export const JOURNEY_LOGIN_ACTION = 'auth_login_success';
export const JOURNEY_LOGOUT_ACTION = 'auth_logout';

/** Retenção padrão dos eventos de jornada (dias). */
export const JOURNEY_DEFAULT_TTL_DAYS = 90;

/**
 * Janela padrão para considerar um vínculo conta↔aparelho "ativo"
 * (aparelho enviou summary autenticado dentro desse prazo e sem logout depois).
 */
export const JOURNEY_ACTIVE_DEVICE_WINDOW_DAYS = 30;

/** Nome do job periódico de limpeza na fila de analytics. */
export const JOURNEY_CLEANUP_JOB = 'journey-cleanup';
export const JOURNEY_CLEANUP_SCHEDULER_ID = 'analytics-journey-cleanup';

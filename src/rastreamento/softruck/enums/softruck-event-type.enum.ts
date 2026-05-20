/**
 * Enum centralizado de todos os tipos de eventos Softruck.
 *
 * Diferente de `SoftruckRelevantEventType` (usado no pipeline do mapa/PDF),
 * este enum contempla o ciclo de vida completo de um evento, incluindo
 * ignição, tipos filtrados (SHAKE_ALERT, UNKNOWN) e TRAJECTORY.
 *
 * Regra de exibição no histórico textual (endpoint /resumo):
 *   - SHAKE_ALERT → FILTRADO (não exibir)
 *   - UNKNOWN     → FILTRADO (não exibir)
 *   - Todos os demais → exibir normalmente
 */
export enum SoftruckEventType {
  // ── Identificador de trajeto (não é alarme) ───────────────
  TRAJECTORY = 'Trajetória',

  // ── Ignição ───────────────────────────────────────────────
  IGNITION_ON = 'Ignição ligada',
  IGNITION_OFF = 'Ignição desligada',

  // ── Velocidade ────────────────────────────────────────────
  OVERSPEED = 'Excesso de velocidade',

  // ── Emergência / segurança ────────────────────────────────
  PANIC = 'Botão de pânico',

  // ── Cerca virtual ─────────────────────────────────────────
  GEOFENCE_ENTER = 'Entrada em cerca virtual',
  GEOFENCE_EXIT = 'Saída de cerca virtual',

  // ── Energia ───────────────────────────────────────────────
  LOW_BATTERY = 'Bateria baixa',
  POWER_CUT = 'Corte de energia externa',

  // ── Conectividade / GPS ───────────────────────────────────
  GPS_LOST = 'Sinal GPS perdido',

  // ── Movimentação suspeita / reboque ───────────────────────
  TOWING = 'Movimentação suspeita',

  // ── Filtrados — não devem aparecer no retorno ─────────────
  SHAKE_ALERT = 'SHAKE_ALERT',
  UNKNOWN = 'UNKNOWN',
}

// ============================================================
// Categoria do evento
// ============================================================

/** Classificação de alto nível do evento (para agrupamento no frontend) */
export enum SoftruckEventCategory {
  /** Alarme gerado pelo dispositivo ou plataforma */
  ALARM = 'ALARM',
  /** Informação de estado do veículo */
  INFO = 'INFO',
}

// ============================================================
// Severidade do evento
// ============================================================

/** Nível de urgência do evento (para coloração / priorização no frontend) */
export enum SoftruckEventSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

// ============================================================
// Filtro de exibição
// ============================================================

/**
 * Conjunto de tipos que devem ser REMOVIDOS do histórico textual.
 * Estender este conjunto para ocultar novos tipos no futuro.
 */
export const FILTERED_EVENT_TYPES = new Set<SoftruckEventType>([
  SoftruckEventType.SHAKE_ALERT,
  SoftruckEventType.UNKNOWN,
]);

/**
 * Verifica se um evento deve aparecer no histórico textual.
 *
 * @returns `true` quando o tipo deve ser exibido, `false` quando deve ser filtrado
 */
export function shouldIncludeEvent(type: SoftruckEventType): boolean {
  return !FILTERED_EVENT_TYPES.has(type);
}

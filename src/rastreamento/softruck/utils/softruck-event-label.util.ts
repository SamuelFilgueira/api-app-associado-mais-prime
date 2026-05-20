import {
  SoftruckEventCategory,
  SoftruckEventSeverity,
  SoftruckEventType,
} from '../enums/softruck-event-type.enum';

// ============================================================
// Labels amigáveis em português
// ============================================================

/** Mapa estático de tipo → label amigável em português (exaustivo). */
const EVENT_LABELS: Record<SoftruckEventType, string> = {
  [SoftruckEventType.TRAJECTORY]: 'Trajeto',
  [SoftruckEventType.IGNITION_ON]: 'Ignição ligada',
  [SoftruckEventType.IGNITION_OFF]: 'Ignição desligada',
  [SoftruckEventType.OVERSPEED]: 'Excesso de velocidade',
  [SoftruckEventType.PANIC]: 'Botão de pânico',
  [SoftruckEventType.GEOFENCE_ENTER]: 'Entrada em cerca virtual',
  [SoftruckEventType.GEOFENCE_EXIT]: 'Saída de cerca virtual',
  [SoftruckEventType.LOW_BATTERY]: 'Bateria baixa',
  [SoftruckEventType.POWER_CUT]: 'Corte de energia externa',
  [SoftruckEventType.GPS_LOST]: 'Sinal GPS perdido',
  [SoftruckEventType.TOWING]: 'Movimentação suspeita (possível reboque)',
  [SoftruckEventType.SHAKE_ALERT]: 'Alerta de vibração',
  [SoftruckEventType.UNKNOWN]: 'Evento desconhecido',
};

/**
 * Retorna a descrição amigável em português para um tipo de evento.
 * Seguro para valores inesperados — retorna fallback genérico.
 */
export function getEventLabel(type: SoftruckEventType): string {
  return EVENT_LABELS[type] ?? 'Evento desconhecido';
}

// ============================================================
// Categorias
// ============================================================

/** Mapa estático de tipo → categoria (exaustivo). */
const EVENT_CATEGORIES: Record<SoftruckEventType, SoftruckEventCategory> = {
  [SoftruckEventType.TRAJECTORY]: SoftruckEventCategory.INFO,
  [SoftruckEventType.IGNITION_ON]: SoftruckEventCategory.INFO,
  [SoftruckEventType.IGNITION_OFF]: SoftruckEventCategory.INFO,
  [SoftruckEventType.OVERSPEED]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.PANIC]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.GEOFENCE_ENTER]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.GEOFENCE_EXIT]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.LOW_BATTERY]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.POWER_CUT]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.GPS_LOST]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.TOWING]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.SHAKE_ALERT]: SoftruckEventCategory.ALARM,
  [SoftruckEventType.UNKNOWN]: SoftruckEventCategory.INFO,
};

/**
 * Retorna a categoria do evento (ALARM | INFO).
 */
export function getEventCategory(type: SoftruckEventType): SoftruckEventCategory {
  return EVENT_CATEGORIES[type] ?? SoftruckEventCategory.INFO;
}

// ============================================================
// Severidades
// ============================================================

/** Mapa estático de tipo → severidade (exaustivo). */
const EVENT_SEVERITIES: Record<SoftruckEventType, SoftruckEventSeverity> = {
  [SoftruckEventType.TRAJECTORY]: SoftruckEventSeverity.LOW,
  [SoftruckEventType.IGNITION_ON]: SoftruckEventSeverity.LOW,
  [SoftruckEventType.IGNITION_OFF]: SoftruckEventSeverity.LOW,
  [SoftruckEventType.OVERSPEED]: SoftruckEventSeverity.HIGH,
  [SoftruckEventType.PANIC]: SoftruckEventSeverity.CRITICAL,
  [SoftruckEventType.GEOFENCE_ENTER]: SoftruckEventSeverity.MEDIUM,
  [SoftruckEventType.GEOFENCE_EXIT]: SoftruckEventSeverity.MEDIUM,
  [SoftruckEventType.LOW_BATTERY]: SoftruckEventSeverity.MEDIUM,
  [SoftruckEventType.POWER_CUT]: SoftruckEventSeverity.HIGH,
  [SoftruckEventType.GPS_LOST]: SoftruckEventSeverity.MEDIUM,
  [SoftruckEventType.TOWING]: SoftruckEventSeverity.CRITICAL,
  [SoftruckEventType.SHAKE_ALERT]: SoftruckEventSeverity.LOW,
  [SoftruckEventType.UNKNOWN]: SoftruckEventSeverity.LOW,
};

/**
 * Retorna a severidade do evento (LOW | MEDIUM | HIGH | CRITICAL).
 */
export function getEventSeverity(type: SoftruckEventType): SoftruckEventSeverity {
  return EVENT_SEVERITIES[type] ?? SoftruckEventSeverity.LOW;
}

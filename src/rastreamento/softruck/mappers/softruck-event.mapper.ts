import { Logger } from '@nestjs/common';
import {
  SoftruckGeomFeature,
  SoftruckGeomPointData,
} from '../interfaces/softruck-trajectories.interface';
import {
  SoftruckEventCategory,
  SoftruckEventSeverity,
  SoftruckEventType,
  shouldIncludeEvent,
} from '../enums/softruck-event-type.enum';
import {
  getEventCategory,
  getEventLabel,
  getEventSeverity,
} from '../utils/softruck-event-label.util';
import { DiaItemEventoDto } from '../dto/historico-resumo-response.dto';

// ============================================================
// Tipos internos
// ============================================================

/** Resultado intermediário da análise de uma feature geom */
interface ParsedGeomEvent {
  tipo: SoftruckEventType;
  descricao: string;
  categoria: SoftruckEventCategory;
  severidade: SoftruckEventSeverity;
  timestamp: string;
  coordenadas: { lat: number; lng: number };
}

// ============================================================
// Normalização de strings
// ============================================================

/** Normaliza um campo textual para comparação (lowercase + trim) */
function n(value: string | undefined | null): string {
  return (value ?? '').toLowerCase().trim();
}

// ============================================================
// Parser de tipo de evento
// ============================================================

/**
 * Classifica o tipo de evento Softruck a partir dos campos brutos
 * de uma feature GeoJSON (tag, val, msg, type).
 *
 * Ordem de prioridade:
 * 1. msg = "shake_alert" → SHAKE_ALERT (filtrado)
 * 2. Ignição (ON / OFF)
 * 3. Excesso de velocidade
 * 4. Pânico / SOS
 * 5. Cerca virtual (enter / exit diferenciados)
 * 6. Bateria baixa
 * 7. Corte de energia externa
 * 8. GPS perdido
 * 9. Movimentação suspeita / reboque
 * 10. Fallback → UNKNOWN (filtrado)
 *
 * @param tag  - Campo `tag` do ponto GPS
 * @param val  - Campo `val` do ponto GPS
 * @param msg  - Campo `msg` do ponto GPS
 */
export function parseEventType(
  tag: string | undefined,
  val: string | undefined,
  msg: string | undefined,
): SoftruckEventType {
  const t = n(tag);
  const v = n(val);
  const m = n(msg);

  // ── Shake alert (filtrado pelo sistema) ─────────────────────
  if (m === 'shake_alert') return SoftruckEventType.SHAKE_ALERT;
  if (t === 'accelerometer' && m === 'shake_alert') return SoftruckEventType.SHAKE_ALERT;

  // ── Ignição ON ──────────────────────────────────────────────
  if (
    t === 'ignition_on' ||
    t === 'ign_on' ||
    t === 'engine_on' ||
    (t === 'ignition' && v === 'on') ||
    (t === 'ign' && v === 'on')
  ) {
    return SoftruckEventType.IGNITION_ON;
  }

  // ── Ignição OFF ─────────────────────────────────────────────
  if (
    t === 'ignition_off' ||
    t === 'ign_off' ||
    t === 'engine_off' ||
    (t === 'ignition' && v === 'off') ||
    (t === 'ign' && v === 'off')
  ) {
    return SoftruckEventType.IGNITION_OFF;
  }

  // ── Excesso de velocidade ───────────────────────────────────
  if (
    t === 'overspeed' ||
    t === 'overspeeding' ||
    t === 'speeding' ||
    t === 'high_speed' ||
    t === 'over_speed' ||
    t === 'harsh_accel' ||
    t === 'harsh_acceleration' ||
    v === 'overspeed' ||
    m === 'overspeed'
  ) {
    return SoftruckEventType.OVERSPEED;
  }

  // ── Pânico / SOS ────────────────────────────────────────────
  if (
    t === 'panic' ||
    t === 'sos' ||
    t === 'panic_button' ||
    m === 'panic' ||
    m === 'sos'
  ) {
    return SoftruckEventType.PANIC;
  }

  // ── Cerca virtual — entrada ─────────────────────────────────
  if (
    t === 'geofence_enter' ||
    t === 'geo_in' ||
    t === 'zone_enter' ||
    t === 'enter_geo' ||
    (t === 'geofence' && (v === 'enter' || v === 'in')) ||
    (t === 'geo_fence' && (v === 'enter' || v === 'in'))
  ) {
    return SoftruckEventType.GEOFENCE_ENTER;
  }

  // ── Cerca virtual — saída ───────────────────────────────────
  if (
    t === 'geofence_exit' ||
    t === 'geo_out' ||
    t === 'zone_exit' ||
    t === 'exit_geo' ||
    (t === 'geofence' && (v === 'exit' || v === 'out')) ||
    (t === 'geo_fence' && (v === 'exit' || v === 'out'))
  ) {
    return SoftruckEventType.GEOFENCE_EXIT;
  }

  // ── Bateria baixa ───────────────────────────────────────────
  if (
    t === 'battery_low' ||
    t === 'low_battery' ||
    t === 'internal_battery_low' ||
    t === 'battery_critical' ||
    t === 'int_battery' ||
    (t === 'battery' && (v === 'low' || v === 'critical'))
  ) {
    return SoftruckEventType.LOW_BATTERY;
  }

  // ── Corte de energia externa ────────────────────────────────
  if (
    t === 'power_cut' ||
    t === 'external_power_cut' ||
    t === 'power_lost' ||
    t === 'main_power_lost' ||
    t === 'ext_power_cut' ||
    t === 'power_off_ext'
  ) {
    return SoftruckEventType.POWER_CUT;
  }

  // ── GPS perdido ─────────────────────────────────────────────
  if (
    t === 'gps_signal_lost' ||
    t === 'gps_lost' ||
    t === 'no_gps' ||
    t === 'gps_fail' ||
    t === 'gps_antenna_cut' ||
    t === 'gps_jamming' ||
    t === 'gps_error'
  ) {
    return SoftruckEventType.GPS_LOST;
  }

  // ── Movimentação suspeita / reboque ─────────────────────────
  if (
    t === 'towing' ||
    t === 'tow' ||
    t === 'vehicle_tow' ||
    t === 'anti_theft' ||
    t === 'antitheft' ||
    t === 'stolen' ||
    t === 'theft' ||
    (t === 'accelerometer' && v === 'vibration')
  ) {
    return SoftruckEventType.TOWING;
  }

  // ── Fallback ────────────────────────────────────────────────
  return SoftruckEventType.UNKNOWN;
}

// ============================================================
// Extração de timestamp do ponto GPS
// ============================================================

/**
 * Extrai o timestamp ISO 8601 de um ponto GPS Softruck.
 * Usa `act` (timestamp da posição GPS) se disponível,
 * caso contrário tenta `cat` (timestamp de recepção).
 * Fallback: timestamp atual.
 */
function extrairTimestamp(point: SoftruckGeomPointData): string {
  if (point.act && point.act > 0) {
    return new Date(point.act * 1000).toISOString();
  }
  if (point.cat && point.cat > 0) {
    return new Date(point.cat * 1000).toISOString();
  }
  return new Date().toISOString();
}

// ============================================================
// Mapper principal
// ============================================================

/**
 * Converte uma feature GeoJSON do tipo ALARM em `DiaItemEventoDto`.
 *
 * Retorna `null` quando:
 * - O tipo não é ALARM
 * - O evento é filtrado (UNKNOWN ou SHAKE_ALERT)
 * - A feature não tem propriedades válidas
 *
 * @param feature - Feature GeoJSON retornada pelo endpoint /trajectories/geom
 * @param logger  - Logger NestJS para registrar eventos ignorados e desconhecidos
 */
export function mapGeomFeatureToEvento(
  feature: SoftruckGeomFeature,
  logger: Logger,
): DiaItemEventoDto | null {
  const props = feature.properties;

  // Apenas features do tipo ALARM geram eventos no histórico
  if (props.type !== 'ALARM') {
    return null;
  }

  const tipo = parseEventType(props.tag, props.val, props.msg);

  // Registra eventos com tipo desconhecido para facilitar expansão futura
  if (tipo === SoftruckEventType.UNKNOWN) {
    logger.debug(
      `[SoftruckEventMapper] Evento UNKNOWN ignorado — tag="${props.tag}" val="${props.val}" msg="${props.msg}"`,
    );
  }

  // Filtra SHAKE_ALERT e UNKNOWN
  if (!shouldIncludeEvent(tipo)) {
    return null;
  }

  // Extrai coordenadas do GeoJSON (formato: [longitude, latitude])
  const [lng, lat] = feature.geometry.coordinates;
  const timestamp = extrairTimestamp(props.point);

  return {
    kind: 'EVENT',
    tipo,
    descricao: getEventLabel(tipo),
    categoria: getEventCategory(tipo) as SoftruckEventCategory,
    severidade: getEventSeverity(tipo) as SoftruckEventSeverity,
    timestamp,
    coordenadas: { lat, lng },
  };
}

/**
 * Mapeia todas as features de uma coleção geom e retorna apenas os eventos válidos.
 *
 * Eventos UNKNOWN e SHAKE_ALERT são silenciosamente removidos (com log de debug).
 * Features do tipo DETAILED (pontos de rota) são ignoradas.
 *
 * @param features - Array de features GeoJSON do endpoint /trajectories/geom
 * @param logger   - Logger NestJS
 */
export function mapGeomFeaturesToEventos(
  features: SoftruckGeomFeature[],
  logger: Logger,
): DiaItemEventoDto[] {
  const eventos: DiaItemEventoDto[] = [];

  for (const feature of features) {
    const evento = mapGeomFeatureToEvento(feature, logger);
    if (evento) {
      eventos.push(evento);
    }
  }

  return eventos;
}

import { SoftruckRelevantEventType } from '../enums/softruck-event.enum';

// ============================================================
// Tags ignoradas — sem relevância visual no mapa
// ============================================================

/**
 * Conjunto de tags ignoradas completamente.
 * Inclui variações de capitalização e formato encontradas na API Softruck.
 */
const IGNORED_TAGS = new Set<string>([
  // Ignição
  'ignition',
  'ignition_on',
  'ignition_off',
  'ign',
  'ign_on',
  'ign_off',
  'engine_on',
  'engine_off',

  // Modos de suspensão
  'sleep',
  'entering_sleep_mode',
  'deep_sleep',
  'wake_up',
  'wakeup',
  'exiting_sleep',
  'sleep_mode',

  // Idle / parado
  'idle',
  'idle_start',
  'idle_end',
  'idling',
  'stop',
  'parking',

  // Heartbeat / keepalive
  'heartbeat',
  'keepalive',
  'keep_alive',
  'ping',
  'network_ping',
  'gps_keepalive',
  'gps_keep_alive',
  'alive',

  // Modo de operação / configuração
  'operation_mode',
  'normal',
  'mode_change',
  'mode_normal',
  'config',
  'configuration',

  // Power genérico (não é corte)
  'power_on',
  'reboot',
  'reset',
  'restart',

  // Sinal GSM / GPS genérico sem relevância
  'gsm',
  'gps_fix',
  'fix',
  'gsm_signal',
  'gps_signal',

  // Início/fim de viagem (já tratados via by-keys)
  'trip_start',
  'trip_end',
  'journey_start',
  'journey_end',
]);

// ============================================================
// Regras de classificação
// ============================================================

/**
 * Regras ordenadas de classificação de eventos.
 * A primeira regra que casar com a tag ou mensagem vence.
 */
const CLASSIFICATION_RULES: ReadonlyArray<{
  readonly keywords: ReadonlyArray<string>;
  readonly type: SoftruckRelevantEventType;
}> = [
  {
    keywords: [
      'speed',
      'overspeed',
      'overspeeding',
      'speeding',
      'high_speed',
      'over_speed',
      'harsh_accel',
      'harsh_acceleration',
      'rapid_acceleration',
    ],
    type: SoftruckRelevantEventType.SPEEDING,
  },
  {
    keywords: ['panic', 'sos', 'panic_button'],
    type: SoftruckRelevantEventType.PANIC,
  },
  {
    keywords: ['emergency', 'mayday', 'emergency_call', 'alert'],
    type: SoftruckRelevantEventType.EMERGENCY,
  },
  {
    keywords: [
      'geofence',
      'geo_fence',
      'geo_in',
      'geo_out',
      'geofence_enter',
      'geofence_exit',
      'enter_geo',
      'exit_geo',
      'zone_enter',
      'zone_exit',
    ],
    type: SoftruckRelevantEventType.GEOFENCE,
  },
  {
    keywords: [
      'towing',
      'tow',
      'vehicle_tow',
      'anti_theft',
      'antitheft',
      'stolen',
      'theft',
      'vibration',
    ],
    type: SoftruckRelevantEventType.TOWING,
  },
  {
    keywords: [
      'power_cut',
      'external_power_cut',
      'power_lost',
      'power_off_ext',
      'main_power_lost',
      'ext_power_cut',
      'power_off',
    ],
    type: SoftruckRelevantEventType.POWER_CUT,
  },
  {
    keywords: [
      'battery_low',
      'low_battery',
      'internal_battery_low',
      'battery_critical',
      'int_battery',
      'battery',
    ],
    type: SoftruckRelevantEventType.LOW_BATTERY,
  },
  {
    keywords: [
      'gps_signal_lost',
      'gps_lost',
      'no_gps',
      'gps_fail',
      'gps_antenna_cut',
      'gps_jamming',
      'gps_error',
    ],
    type: SoftruckRelevantEventType.GPS_SIGNAL_LOST,
  },
  {
    keywords: [
      'offline',
      'device_offline',
      'communication_lost',
      'no_signal',
      'device_lost',
      'disconnected',
    ],
    type: SoftruckRelevantEventType.DEVICE_OFFLINE,
  },
];

// ============================================================
// Função principal
// ============================================================

/**
 * Normaliza os campos brutos de um evento Softruck em um tipo padronizado.
 *
 * Retorna `null` quando o evento deve ser ignorado (ignição, idle, heartbeat, etc.)
 * ou quando não pertence a nenhuma categoria relevante conhecida.
 *
 * A verificação ocorre na seguinte ordem:
 * 1. Tag exatamente na lista de ignorados → null
 * 2. Tag bate com regras de classificação → tipo relevante
 * 3. Fallback: msg bate com regras → tipo relevante
 * 4. Tag desconhecida → null (descarta para não poluir o mapa)
 *
 * @param tag - Campo `tag` do ponto GPS Softruck
 * @param msg - Campo `msg` do ponto GPS (fallback descritivo)
 * @param val - Campo `val` (raramente relevante para classificação)
 * @param org - Campo `org` (origem original do evento, raramente útil)
 */
export function classifyEvent(
  tag: string | undefined,
  msg?: string,
  val?: string,
  org?: string,
): SoftruckRelevantEventType | null {
  const rawTag = (tag ?? '').toLowerCase().trim();

  if (!rawTag) return null;
  if (IGNORED_TAGS.has(rawTag)) return null;

  // Verifica regras contra a tag
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.keywords.some((k) => rawTag === k || rawTag.includes(k))) {
      return rule.type;
    }
  }

  // Fallback: verifica o campo msg (pode ser mais descritivo que a tag)
  const rawMsg = (msg ?? '').toLowerCase().trim();
  if (rawMsg) {
    for (const rule of CLASSIFICATION_RULES) {
      if (rule.keywords.some((k) => rawMsg.includes(k))) {
        return rule.type;
      }
    }
  }

  // Tag desconhecida → descarta para não poluir o mapa
  return null;
}

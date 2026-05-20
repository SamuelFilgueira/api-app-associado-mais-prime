/**
 * Tipos de eventos Softruck considerados relevantes para exibição no mapa.
 *
 * Eventos de ignição, idle, heartbeat e similares são intencionalmente
 * excluídos — eles são processados e descartados pelo EventClassifierHelper.
 */
export enum SoftruckRelevantEventType {
  SPEEDING = 'SPEEDING',
  PANIC = 'PANIC',
  GEOFENCE = 'GEOFENCE',
  TOWING = 'TOWING',
  POWER_CUT = 'POWER_CUT',
  LOW_BATTERY = 'LOW_BATTERY',
  GPS_SIGNAL_LOST = 'GPS_SIGNAL_LOST',
  DEVICE_OFFLINE = 'DEVICE_OFFLINE',
  EMERGENCY = 'EMERGENCY',
}

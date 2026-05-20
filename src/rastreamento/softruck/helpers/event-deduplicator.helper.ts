import { SoftruckGeomFeature } from '../interfaces/softruck-trajectories.interface';
import { SoftruckEventType } from '../enums/softruck-event-type.enum';
import { parseEventType } from '../mappers/softruck-event.mapper';
import { haversineMeters } from '../utils/geo.utils';

/** Distância máxima em metros para considerar dois eventos do mesmo tipo como duplicatas */
const DEDUP_DISTANCE_METERS = 300;

/** Intervalo máximo em segundos para considerar dois eventos do mesmo tipo como duplicatas */
const DEDUP_TIME_SECONDS = 300; // 5 minutos

// ============================================================
// Tipo interno de trabalho
// ============================================================

interface ClassifiedFeature {
  feature: SoftruckGeomFeature;
  eventType: SoftruckEventType;
  lat: number;
  lng: number;
  act: number;
}

// ============================================================
// Funções internas
// ============================================================

/**
 * Retorna `true` se dois eventos devem ser mesclados (são duplicatas próximas).
 *
 * Critérios (todos devem ser atendidos):
 * - Mesmo tipo normalizado
 * - Distância ≤ 300 metros
 * - Diferença de tempo ≤ 5 minutos
 */
function shouldMergeNearbyEvents(
  a: ClassifiedFeature,
  b: ClassifiedFeature,
): boolean {
  if (a.eventType !== b.eventType) return false;

  const dist = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  const timeDiff = Math.abs(a.act - b.act);

  return dist <= DEDUP_DISTANCE_METERS && timeDiff <= DEDUP_TIME_SECONDS;
}

// ============================================================
// Função principal
// ============================================================

/**
 * Filtra e deduplica os eventos de alarme vindos do endpoint `/trajectories/geom`.
 *
 * Pipeline:
 * 1. Descarta eventos com tag `accelerometer`
 * 2. Descarta eventos sem classificação conhecida (UNKNOWN)
 * 3. Remove duplicatas espaço-temporais do mesmo tipo (≤300m e ≤5min → mantém o primeiro)
 *
 * Objetivo: entregar apenas eventos realmente significativos para o mapa.
 *
 * @param rawAlarmFeatures - Features brutas do tipo ALARM vindas da Softruck
 * @returns Features filtradas e deduplicadas, prontas para exibição no mapa
 */
export function filterAndDeduplicateAlarms(
  rawAlarmFeatures: SoftruckGeomFeature[],
): SoftruckGeomFeature[] {
  if (rawAlarmFeatures.length === 0) return [];

  // Etapa 1: classificar — descartar apenas accelerometer e UNKNOWN
  const classified: ClassifiedFeature[] = [];

  for (const feature of rawAlarmFeatures) {
    const { tag, val, msg } = feature.properties;

    // Filtra eventos do acelerômetro (geram muito ruído)
    if ((tag ?? '').toLowerCase().trim() === 'accelerometer') continue;

    const eventType = parseEventType(tag, val, msg);

    // Filtra eventos sem classificação conhecida
    if (eventType === SoftruckEventType.UNKNOWN) continue;

    const [lng, lat] = feature.geometry.coordinates;
    const act = feature.properties.point.act ?? 0;

    classified.push({ feature, eventType, lat, lng, act });
  }

  // Etapa 2: deduplicar — para cada candidato, verificar se já existe
  // um evento do mesmo tipo na vizinhança espaço-temporal
  const kept: ClassifiedFeature[] = [];

  for (const current of classified) {
    const isDuplicate = kept.some((prev) =>
      shouldMergeNearbyEvents(prev, current),
    );

    if (!isDuplicate) {
      kept.push(current);
    }
  }

  return kept.map(({ feature }) => feature);
}

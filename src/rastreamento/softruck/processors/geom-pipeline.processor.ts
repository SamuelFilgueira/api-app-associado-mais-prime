import { Injectable, Logger } from '@nestjs/common';
import {
  SoftruckGeomFeature,
  SoftruckGeomFeatureCollection,
} from '../interfaces/softruck-trajectories.interface';
import { HistoricoSegmentoDto, RouteSegment } from '../dto/historico-response.dto';
import { filterAndDeduplicateAlarms } from '../helpers/event-deduplicator.helper';
import { simplifyRoutePoints } from '../helpers/route-simplifier.helper';
import { buildRouteSegments } from '../helpers/trip-segmenter.helper';

// ============================================================
// Tipos de saída do pipeline
// ============================================================

export interface GeomPipelineStats {
  /** Pontos de rota brutos recebidos da API */
  rawRoutePoints: number;
  /** Pontos de rota após simplificação */
  simplifiedRoutePoints: number;
  /** Alarmes brutos recebidos da API */
  rawAlarms: number;
  /** Alarmes após filtro e deduplicação */
  filteredAlarms: number;
}

export interface GeomPipelineResult {
  /** FeatureCollection consolidada (rota simplificada + alarmes filtrados) */
  geojson: SoftruckGeomFeatureCollection;
  /** Pontos de rota simplificados (DETAILED) */
  routeFeatures: SoftruckGeomFeature[];
  /** Eventos relevantes filtrados e deduplicados (ALARM) */
  alarmFeatures: SoftruckGeomFeature[];
  /** Viagens individuais mapeadas a partir dos segmentos by-keys */
  segments: RouteSegment[];
  /** Métricas de redução para fins de log */
  stats: GeomPipelineStats;
}

// ============================================================
// Processor
// ============================================================

/**
 * Orquestra o pipeline completo de processamento das features GeoJSON
 * retornadas pelo endpoint `/trajectories/geom` da Softruck.
 *
 * Responsabilidades (uma por etapa):
 * 1. Separar features por tipo (DETAILED / ALARM)
 * 2. Simplificar pontos de rota (remove jitter e redundâncias)
 * 3. Filtrar e deduplicar alarmes (remove ignição, idle, heartbeat e duplicatas)
 * 4. Construir segmentos de viagem a partir dos dados do by-keys
 * 5. Montar FeatureCollection consolidada
 *
 * Este service é injetável para facilitar testes unitários
 * e substituição futura de estratégias de processamento.
 */
@Injectable()
export class GeomPipelineProcessor {
  private readonly logger = new Logger(GeomPipelineProcessor.name);

  process(
    rawFeatures: SoftruckGeomFeature[],
    segmentos: HistoricoSegmentoDto[],
  ): GeomPipelineResult {
    // Etapa 1: separar features por tipo
    const rawRouteFeatures = rawFeatures.filter(
      (f) => f.properties.type === 'DETAILED',
    );
    const rawAlarmFeatures = rawFeatures.filter(
      (f) => f.properties.type === 'ALARM',
    );

    // Etapa 2: simplificar pontos de rota
    const simplifiedRoute = simplifyRoutePoints(rawRouteFeatures);

    // Etapa 3: filtrar e deduplicar alarmes
    const filteredAlarms = filterAndDeduplicateAlarms(rawAlarmFeatures);

    // Etapa 4: construir segmentos de viagem
    const segments = buildRouteSegments(segmentos);

    // Log de redução para monitoramento
    const stats: GeomPipelineStats = {
      rawRoutePoints: rawRouteFeatures.length,
      simplifiedRoutePoints: simplifiedRoute.length,
      rawAlarms: rawAlarmFeatures.length,
      filteredAlarms: filteredAlarms.length,
    };

    // Etapa 5: FeatureCollection consolidada com dados processados
    const geojson: SoftruckGeomFeatureCollection = {
      type: 'FeatureCollection',
      features: [...simplifiedRoute, ...filteredAlarms],
    };

    return {
      geojson,
      routeFeatures: simplifiedRoute,
      alarmFeatures: filteredAlarms,
      segments,
      stats,
    };
  }
}

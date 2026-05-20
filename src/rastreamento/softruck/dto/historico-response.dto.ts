import {
  SoftruckGeomFeature,
  SoftruckGeomFeatureCollection,
} from '../interfaces/softruck-trajectories.interface';

// ============================================================
// Informações do veículo
// ============================================================

export interface VehicleInfoDto {
  chassi: string;
  plate: string;
  brandName: string;
  modelName: string;
}

// ============================================================
// Informações do período consultado
// ============================================================

export interface PeriodInfoDto {
  dataInicial: string;
  dataFinal: string;
  totalDias: number;
}

// ============================================================
// Segmento individual de viagem (resultado do by-keys)
// ============================================================

export interface SegmentPointDto {
  /** Timestamp ISO 8601 */
  act: string;
  lat: number;
  lng: number;
  /** Endereço textual da Softruck (pode estar ausente) */
  adr?: string;
}

export interface HistoricoSegmentoDto {
  id: string;
  /** Data no formato YYYYMMDD representando o dia deste segmento */
  acc: number;
  inicio: SegmentPointDto;
  fim: SegmentPointDto;
  /** Duração em segundos */
  duracaoSegundos: number;
  /** Distância em metros */
  distanciaMetros: number;
  /** Velocidade máxima em km/h */
  velocidadeMaxima: number;
  /** Velocidade média em km/h */
  velocidadeMedia: number;
}

// ============================================================
// Sumário consolidado do período
// ============================================================

export interface HistoricoSummaryDto {
  totalSegmentos: number;
  distanciaTotalMetros: number;
  duracaoTotalSegundos: number;
  velocidadeMaximaGeral: number;
  velocidadeMediaGeral: number;
  diasComDados: number;
}

// ============================================================
// Segmento de viagem processado (response do endpoint /rotas)
// ============================================================

/** Ponto de início ou fim de um segmento de viagem */
export interface RouteSegmentPoint {
  lat: number;
  lng: number;
  /** Timestamp Unix (segundos desde epoch) */
  act: number;
  /** Endereço textual do local (pode estar ausente) */
  adr?: string;
}

/**
 * Representa uma viagem individual detectada no período consultado.
 * Derivado dos segmentos do endpoint /by-keys, já calculados pela Softruck.
 */
export interface RouteSegment {
  /** Timestamp Unix de início da viagem */
  startedAt: number;
  /** Timestamp Unix de fim da viagem */
  endedAt: number;
  /** Duração total da viagem em segundos */
  durationSeconds: number;
  /** Distância percorrida em metros */
  distanceMeters: number;
  /** Velocidade média da viagem em km/h */
  averageSpeed: number;
  /** Velocidade máxima registrada na viagem em km/h */
  maxSpeed: number;
  /** Coordenada de início da viagem */
  startPoint: RouteSegmentPoint;
  /** Coordenada de fim da viagem */
  endPoint: RouteSegmentPoint;
}

// ============================================================
// Resposta do endpoint de rotas detalhadas (GeoJSON)
// ============================================================

export interface HistoricoRotasSummaryDto extends HistoricoSummaryDto {
  /** Total de pontos GPS de rota após simplificação */
  totalFeaturesDetalhadas: number;
  /** Total de alarmes relevantes após filtro e deduplicação */
  totalAlarmes: number;
}

export interface HistoricoRotasResponseDto {
  vehicle: VehicleInfoDto;
  period: PeriodInfoDto;
  summary: HistoricoRotasSummaryDto;
  /** FeatureCollection GeoJSON consolidada (pontos de rota + alarmes filtrados) */
  geojson: SoftruckGeomFeatureCollection;
  /**
   * Viagens individuais detectadas no período.
   * Cada entry representa uma saída/chegada com duração, distância e velocidades.
   */
  segments: RouteSegment[];
  grouped: {
    /** Pontos GPS de rota simplificados (type: DETAILED) */
    routeFeatures: SoftruckGeomFeature[];
    /** Eventos relevantes filtrados e deduplicados (type: ALARM) */
    alarmFeatures: SoftruckGeomFeature[];
  };
}

// ============================================================
// Dados internos usados para geração do PDF
// ============================================================

export interface HistoricoPdfDataDto {
  vehicle: VehicleInfoDto;
  period: PeriodInfoDto;
  summary: HistoricoSummaryDto;
  segmentos: HistoricoSegmentoDto[];
}

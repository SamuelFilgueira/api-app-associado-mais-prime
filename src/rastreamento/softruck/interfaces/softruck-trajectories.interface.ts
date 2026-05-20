/**
 * Interfaces para os endpoints de trajetórias da API Softruck:
 * - GET /vehicles/:vehicleId/trajectories/by-keys  → resumo diário de segmentos
 * - GET /vehicles/:vehicleId/trajectories/geom     → GeoJSON com pontos GPS
 */

// ============================================================
// Interfaces do endpoint /trajectories/by-keys
// ============================================================

/** Ponto de início ou fim de um segmento (by-keys) */
export interface SoftruckByKeysPoint {
  /** Timestamp ISO 8601 do evento */
  act: string;
  lat: number;
  lng: number;
  /** Endereço textual fornecido pela Softruck (pode estar ausente) */
  adr?: string;
}

/** Segmento individual de viagem dentro de uma trajetória diária */
export interface SoftruckByKeysSegment {
  id: string;
  sta: SoftruckByKeysPoint;
  end: SoftruckByKeysPoint;
  /** Duração do segmento em segundos */
  dur: number;
  /** Distância percorrida em metros */
  dis: number;
  /** Distância validada pelo sistema em metros */
  vDis?: number;
  /** Velocidade máxima em km/h */
  spMax?: number;
  /** Velocidade média em km/h */
  spAvg?: number;
  /** Número de paradas */
  stCnt?: number;
  /** Duração total de paradas em segundos */
  stDur?: number;
  /** Número de alarmes no segmento */
  alCnt?: number;
  hisP?: number;
  hisDur?: number;
  gpsCnt?: number;
  alTags?: string[];
  fixP?: number;
  iDev?: unknown[];
}

/** Perfil de condução diário embutido nos atributos da trajetória */
export interface SoftruckByKeysProfile {
  eid: string;
  did: string;
  vid: string;
  acc: number;
  id?: string;
  igon?: boolean;
  igof?: boolean;
  igmi?: number;
  igma?: number;
  igav?: number;
  blo?: number;
  con?: number;
}

/** LineString GeoJSON para representação visual da rota */
export interface SoftruckByKeysLineString {
  type: string;
  coordinates: [number, number][];
}

/** Atributos de uma trajetória diária retornada pelo endpoint by-keys */
export interface SoftruckByKeysAttributes {
  /** Data no formato YYYYMMDD (ex.: 20260501) */
  acc: number;
  dtp?: string;
  /** Duração total em movimento em segundos */
  dur: number;
  /** Distância total percorrida em metros */
  dis: number;
  vDis?: number;
  raDur?: number;
  /** Velocidade máxima do dia em km/h */
  spMax: number;
  /** Velocidade média do dia em km/h */
  spAvg: number;
  /** Número de segmentos de viagem */
  sgCnt?: number;
  stCnt?: number;
  stDur?: number;
  alCnt?: number;
  alTags?: string[];
  fixP?: number;
  hisP?: number;
  hisDur?: number;
  gpsCnt?: number;
  /** Centro geográfico da trajetória: [longitude, latitude] */
  cen?: [number, number];
  /** Bounding box: [minLng, minLat, maxLng, maxLat] */
  bbox?: [number, number, number, number];
  /** Polyline simplificada do dia no formato GeoJSON LineString */
  ls?: SoftruckByKeysLineString;
  prof?: SoftruckByKeysProfile;
  /** Lista de segmentos individuais de viagem */
  segs?: SoftruckByKeysSegment[];
}

/** Relacionamentos de uma trajetória diária */
export interface SoftruckByKeysRelationships {
  enterprise: {
    type: string;
    id: string;
    attributes: Record<string, unknown>;
  };
  device: {
    type: string;
    id: string;
    attributes: Record<string, unknown>;
  };
  vehicle: {
    type: string;
    id: string;
    attributes: Record<string, unknown>;
  };
}

/** Item raiz retornado pelo endpoint by-keys */
export interface SoftruckByKeysData {
  id: string;
  type: string;
  attributes: SoftruckByKeysAttributes;
  relationships: SoftruckByKeysRelationships;
}

/** Resposta completa do endpoint GET /vehicles/:vehicleId/trajectories/by-keys */
export interface SoftruckByKeysApiResponse {
  data: SoftruckByKeysData;
}

// ============================================================
// Interfaces do endpoint /trajectories/geom
// ============================================================

/** Tipo de feature GeoJSON no endpoint geom */
export type SoftruckGeomFeatureType = 'DETAILED' | 'ALARM';

/** Dados do ponto GPS individual retornado no campo `point` de cada feature */
export interface SoftruckGeomPointData {
  did: string;
  acc: number;
  lng: number;
  lat: number;
  ign: boolean;
  tag: string;
  val: string;
  msg: string;
  dis?: number;
  hmt?: number;
  fix?: boolean;
  org?: string;
  his?: boolean;
  loc?: string;
  sv?: string;
  mod?: string;
  mn?: number;
  rfid?: string;
  mcc?: number | string;
  mnc?: number | string;
  lac?: number | string;
  cid?: string;
  rpm?: string;
  md?: string;
  pn?: string;
  ntw?: string;
  lcs?: string;
  i1?: string;
  i2?: string;
  i3?: string;
  o1?: number | string;
  o2?: string;
  bl?: number;
  sc?: number;
  cb?: string;
  gsm?: number;
  spd?: number;
  dir?: number;
  pv?: number;
  bbv?: number;
  alt?: string;
  vl?: string;
  /** Timestamp Unix de recebimento do ponto */
  cat?: number;
  /** Timestamp Unix da posição GPS */
  act?: number;
  others?: Record<string, unknown>;
}

/** Propriedades de uma feature GeoJSON retornada pelo endpoint geom */
export interface SoftruckGeomFeatureProperties {
  type: SoftruckGeomFeatureType;
  /** Somente presente em features do tipo ALARM */
  tag?: string;
  val?: string;
  msg?: string;
  point: SoftruckGeomPointData;
}

/** Feature GeoJSON individual retornada pelo endpoint geom */
export interface SoftruckGeomFeature {
  type: 'Feature';
  properties: SoftruckGeomFeatureProperties;
  geometry: {
    type: 'Point';
    /** Coordenadas no padrão GeoJSON: [longitude, latitude] */
    coordinates: [number, number];
  };
}

/** FeatureCollection GeoJSON retornada pelo endpoint geom */
export interface SoftruckGeomFeatureCollection {
  type: 'FeatureCollection';
  features: SoftruckGeomFeature[];
}

/** Resposta completa do endpoint GET /vehicles/:vehicleId/trajectories/geom */
export interface SoftruckGeomApiResponse {
  data: SoftruckGeomFeatureCollection;
}

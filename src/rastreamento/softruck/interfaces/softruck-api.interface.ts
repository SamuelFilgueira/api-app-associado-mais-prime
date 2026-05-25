export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export interface TokenEntry {
  token: string;
  expiresAt: number;
}

export interface JwtPayload {
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

export interface SoftruckVehicleResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: {
      plate: string;
      brand_name: string;
      model_name: string;
    };
  }>;
}

export interface SoftruckDeviceAssociationResponse {
  data: Array<{
    id: string;
    attributes: {
      created_at: string;
      is_main_device: boolean;
      deleted_at: string | null;
    };
    relationships: {
      device: {
        id: string;
      };
      vehicle: {
        id: string;
      };
    };
  }>;
}

export interface SoftruckTrackingResponse {
  data: {
    type: string;
    attributes: {
      ign: boolean;
      act: number;
      spd: number;
      geometry: {
        coordinates: [number | string, number | string];
      };
    };
  };
}

export interface SoftruckTrajectoryPoint {
  act?: number;
  acc?: number;
  lat: number;
  lng: number;
}

/**
 * Geometria LineString retornada pela API Softruck.
 * Coordenadas no formato GeoJSON: [longitude, latitude].
 */
export interface SoftruckLsGeometry {
  type?: string;
  coordinates: [number, number][];
}

/** Segmento individual de viagem dentro de um dia (attributes.segs[]) */
export interface SoftruckTrajectorySegment {
  sta: SoftruckTrajectoryPoint;
  end: SoftruckTrajectoryPoint;
  dur: number;
  dis: number;
  spMax?: number;
  spAvg?: number;
  /** Polyline do segmento em formato GeoJSON LineString (opcional) */
  ls?: SoftruckLsGeometry;
}

/** Resumo diário retornado pela API — cada item representa um dia */
export interface SoftruckTrajectoryAttributes {
  acc: number;
  dur: number;
  dis: number;
  spMax: number;
  spAvg: number;
  sgCnt?: number;
  segs?: SoftruckTrajectorySegment[];
  /** Polyline completa do dia em formato GeoJSON LineString (opcional) */
  ls?: SoftruckLsGeometry;
  /**
   * Centro geográfico da trajetória retornado pela API.
   * Usado como `mapCenter` quando disponível.
   */
  cen?: { lat: number; lng: number };
  /**
   * Bounding box da trajetória no formato GeoJSON:
   * [minLongitude, minLatitude, maxLongitude, maxLatitude]
   */
  bbox?: [number, number, number, number];
}

export interface SoftruckTrajectoryItem {
  id: string;
  type: string;
  attributes: SoftruckTrajectoryAttributes;
}

export interface SoftruckTrajectoriesApiResponse {
  data: SoftruckTrajectoryItem[];
}

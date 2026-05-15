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

/** Segmento individual de viagem dentro de um dia (attributes.segs[]) */
export interface SoftruckTrajectorySegment {
  sta: SoftruckTrajectoryPoint;
  end: SoftruckTrajectoryPoint;
  dur: number;
  dis: number;
  spMax?: number;
  spAvg?: number;
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
}

export interface SoftruckTrajectoryItem {
  id: string;
  type: string;
  attributes: SoftruckTrajectoryAttributes;
}

export interface SoftruckTrajectoriesApiResponse {
  data: SoftruckTrajectoryItem[];
}

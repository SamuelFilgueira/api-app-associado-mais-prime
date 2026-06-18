export interface UltimaPosicaoSoftruckResponse {
  date: string;
  ign?: boolean;
  speed: number;
  voltagem?: number | null;
  latitude: number;
  longitude: number;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  plate: string;
  brandName: string;
  modelName: string;
}

export interface UltimaPosicaoSoftruckResponse {
  date: string;
  ign?: boolean;
  speed: number;
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

export interface TrajetoriaSoftruckRota {
  startDate: string;
  endDate: string;
  durationInSeconds: number;
  durationFormatted: string;
  distanceInMeters: number;
  distanceInKm: number;
  maxSpeed: number;
  averageSpeed: number;
  startPosition: {
    latitude: number;
    longitude: number;
  };
  endPosition: {
    latitude: number;
    longitude: number;
  };
}

export interface TrajetoriasSoftruckResponse {
  vehicle: {
    plate: string;
    brandName: string;
    modelName: string;
  };
  routes: TrajetoriaSoftruckRota[];
}

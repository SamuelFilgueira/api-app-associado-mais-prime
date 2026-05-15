import {
  TrajetoriaSoftruckRota,
  TrajetoriasSoftruckResponse,
} from '../dto/trajetorias.dto';
import { SoftruckTrajectoriesApiResponse } from '../interfaces/softruck-api.interface';
import { formatarDuracao, formatarTimestampSoftruck } from '../utils/formatters';

export function mapearTrajetoriasSoftruck(
  data: SoftruckTrajectoriesApiResponse,
  vehicleData: { id: string; plate: string; brandName: string; modelName: string },
): TrajetoriasSoftruckResponse {
  const routes: TrajetoriaSoftruckRota[] = [];

  for (const item of data.data) {
    const segs = item.attributes.segs ?? [];

    for (const seg of segs) {
      if (
        !seg.sta ||
        !seg.end ||
        !Number.isFinite(Number(seg.sta.lat)) ||
        !Number.isFinite(Number(seg.sta.lng)) ||
        !Number.isFinite(Number(seg.end.lat)) ||
        !Number.isFinite(Number(seg.end.lng)) ||
        !Number.isFinite(Number(seg.dur)) ||
        !Number.isFinite(Number(seg.dis)) ||
        Number(seg.dur) < 600 // ignora trechos com menos de 10 minutos
      ) {
        continue;
      }

      const distanceInMeters = Number(seg.dis);
      const durationInSeconds = Number(seg.dur);

      routes.push({
        startDate: formatarTimestampSoftruck(seg.sta.act ?? seg.sta.acc ?? 0),
        endDate: formatarTimestampSoftruck(seg.end.act ?? seg.end.acc ?? 0),
        durationInSeconds,
        durationFormatted: formatarDuracao(durationInSeconds),
        distanceInMeters,
        distanceInKm: Number((distanceInMeters / 1000).toFixed(2)),
        maxSpeed: Number(seg.spMax ?? 0),
        averageSpeed: Number(seg.spAvg ?? 0),
        startPosition: {
          latitude: Number(seg.sta.lat),
          longitude: Number(seg.sta.lng),
        },
        endPosition: {
          latitude: Number(seg.end.lat),
          longitude: Number(seg.end.lng),
        },
      });
    }
  }

  return {
    vehicle: {
      plate: vehicleData.plate,
      brandName: vehicleData.brandName,
      modelName: vehicleData.modelName,
    },
    routes,
  };
}

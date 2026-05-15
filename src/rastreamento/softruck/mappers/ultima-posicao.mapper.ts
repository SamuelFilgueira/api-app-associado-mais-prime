import { InternalServerErrorException } from '@nestjs/common';
import { UltimaPosicaoSoftruckResponse } from '../dto/ultima-posicao.dto';
import { SoftruckTrackingResponse } from '../interfaces/softruck-api.interface';
import { formatarData, parseCoordinate } from '../utils/formatters';

export function mapearUltimaPosicaoSoftruck(
  data: SoftruckTrackingResponse,
  vehicleData: { id: string; plate: string; brandName: string; modelName: string },
): UltimaPosicaoSoftruckResponse {
  const attributes = data.data.attributes;

  const date = formatarData(attributes.act);

  const [longitudeRaw, latitudeRaw] = attributes.geometry.coordinates;
  const longitude = parseCoordinate(longitudeRaw);
  const latitude = parseCoordinate(latitudeRaw);

  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new InternalServerErrorException(
      'Coordenadas inválidas retornadas pela Softruck',
    );
  }

  return {
    date,
    ign: attributes.ign,
    speed: attributes.spd,
    latitude,
    longitude,
    coordinates: {
      latitude,
      longitude,
    },
    plate: vehicleData.plate,
    brandName: vehicleData.brandName,
    modelName: vehicleData.modelName,
  };
}

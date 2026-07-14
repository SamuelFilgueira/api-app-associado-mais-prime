import { InternalServerErrorException } from '@nestjs/common';
import { UltimaPosicaoSoftruckResponse } from '../dto/ultima-posicao.dto';
import { SoftruckTrackingResponse } from '../interfaces/softruck-api.interface';
import { formatarData, parseCoordinate } from '../utils/formatters';

export function mapearUltimaPosicaoSoftruck(
  data: SoftruckTrackingResponse,
  vehicleData: { id: string; plate: string; brandName: string; modelName: string },
): UltimaPosicaoSoftruckResponse {
  const attributes = data.data.attributes;
  // console.debug(`Mapping Softruck tracking response: ${JSON.stringify(data)}`);
  const date = formatarData(attributes.act);

  const [longitudeRaw, latitudeRaw] = attributes.geometry.coordinates;
  const longitude = parseCoordinate(longitudeRaw);
  const latitude = parseCoordinate(latitudeRaw);
  const voltagemRaw = attributes.pv;
  const voltagemParsed =
    typeof voltagemRaw === 'number'
      ? voltagemRaw
      : typeof voltagemRaw === 'string'
        ? Number.parseFloat(voltagemRaw.replace(',', '.'))
        : Number.NaN;
  const voltagem = Number.isFinite(voltagemParsed) ? voltagemParsed : null;
  //console.log(`Parsed coordinates: latitude=${latitude}, longitude=${longitude}, voltagem=${voltagem}`);

  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new InternalServerErrorException(
      'Coordenadas inválidas retornadas pela Softruck',
    );
  }

  return {
    date,
    ign: attributes.ign,
    speed: attributes.spd,
    voltagem,
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

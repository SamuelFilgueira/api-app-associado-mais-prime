import { M7PontoHistoricoRaw } from '../interfaces/m7-historico.interface';
import { HistoricoM7RotasPontoDto } from '../dto/historico-m7-response.dto';

/** Distância mínima entre pontos consecutivos (metros) */
const MIN_DISTANCIA_METROS = 15;

/** Intervalo mínimo entre pontos consecutivos (segundos) */
const MIN_INTERVALO_SEGUNDOS = 5;

function calcularDistanciaMetros(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseIgnicao(value: boolean | number | string | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'ligado';
  }
  return false;
}

export function sanitizarPontosGps(
  pontos: M7PontoHistoricoRaw[],
): HistoricoM7RotasPontoDto[] {
  const resultado: HistoricoM7RotasPontoDto[] = [];
  let ultimo: HistoricoM7RotasPontoDto | null = null;

  for (const ponto of pontos) {
    const lat = Number(ponto.latitude);
    const lng = Number(ponto.longitude);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat === 0 ||
      lng === 0 ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      continue;
    }

    if (!ponto.data_gps) continue;

    const dataGps = String(ponto.data_gps);
    const velocidade = Number(ponto.velocidade ?? 0);

    if (ultimo) {
      const distancia = calcularDistanciaMetros(
        ultimo.latitude,
        ultimo.longitude,
        lat,
        lng,
      );
      const intervaloMs =
        new Date(dataGps).getTime() - new Date(ultimo.dataGps).getTime();
      const intervaloSeg = intervaloMs / 1000;

      if (
        distancia < MIN_DISTANCIA_METROS &&
        intervaloSeg < MIN_INTERVALO_SEGUNDOS
      ) {
        continue;
      }
    }

    const normalizado: HistoricoM7RotasPontoDto = {
      latitude: lat,
      longitude: lng,
      velocidade: Number.isFinite(velocidade) ? velocidade : 0,
      ignicao: parseIgnicao(ponto.ignicao),
      dataGps,
    };

    resultado.push(normalizado);
    ultimo = normalizado;
  }

  return resultado;
}

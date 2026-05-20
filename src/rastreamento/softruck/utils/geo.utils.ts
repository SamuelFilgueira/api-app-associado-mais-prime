/** Raio médio da Terra em metros */
const EARTH_RADIUS_M = 6_371_000;

/**
 * Calcula a distância em metros entre dois pontos geográficos
 * usando a fórmula de Haversine.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lng2 - lng1);

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calcula o bearing (azimute) em graus [0, 360) do ponto A para o ponto B.
 */
export function bearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Retorna a menor diferença angular entre dois bearings (resultado em [0, 180]).
 */
export function headingDiff(b1: number, b2: number): number {
  const diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

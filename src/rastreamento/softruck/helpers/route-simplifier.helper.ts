import { SoftruckGeomFeature } from '../interfaces/softruck-trajectories.interface';
import { haversineMeters, bearing, headingDiff } from '../utils/geo.utils';

// ============================================================
// Thresholds de simplificação
// ============================================================

/**
 * Distância mínima em metros para considerar que houve deslocamento real.
 * Pontos mais próximos que isso do anterior são tratados como jitter GPS.
 */
const MIN_MOVE_DISTANCE_METERS = 10;

/**
 * Distância mínima em metros para manter um ponto em linha reta
 * (sem mudança de direção relevante). Evita lacunas visuais em rodovias.
 */
const STRAIGHT_LINE_KEEP_DISTANCE_METERS = 30;

/**
 * Mudança mínima de direção em graus para forçar a manutenção do ponto.
 * Garante que curvas e manobras sejam preservadas na rota.
 */
const MIN_HEADING_CHANGE_DEGREES = 15;

// ============================================================
// Função principal
// ============================================================

/**
 * Simplifica um array de features GPS removendo pontos redundantes,
 * preservando a fidelidade visual da rota em trajetos urbanos e rodovias.
 *
 * Estratégia (leve, não destrutiva):
 * 1. Ordena pontos por timestamp (act)
 * 2. Remove coordenadas exatas duplicadas
 * 3. Remove pontos < 10m do anterior (filtra jitter GPS)
 * 4. Mantém pontos onde há mudança de direção ≥ 15° (preserva curvas)
 * 5. Mantém pontos a ≥ 30m do anterior mesmo sem curva (preserva retas longas)
 * 6. Sempre mantém o primeiro e o último ponto
 *
 * Não usa simplificação agressiva (ex.: Douglas-Peucker com tolerância alta)
 * para preservar trajetos em áreas urbanas com ruas próximas.
 *
 * @param features - Features DETAILED brutas vindas da API Softruck
 * @returns Features simplificadas, preservando shape visual da rota
 */
export function simplifyRoutePoints(
  features: SoftruckGeomFeature[],
): SoftruckGeomFeature[] {
  if (features.length <= 2) return features;

  // Ordena por timestamp para garantir sequência temporal correta
  const sorted = [...features].sort(
    (a, b) =>
      (a.properties.point.act ?? 0) - (b.properties.point.act ?? 0),
  );

  const result: SoftruckGeomFeature[] = [sorted[0]];
  let prevBearing: number | null = null;

  for (let i = 1; i < sorted.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = sorted[i];

    const [prevLng, prevLat] = prev.geometry.coordinates;
    const [currLng, currLat] = curr.geometry.coordinates;

    // Remove coordenadas exatas duplicadas
    if (currLat === prevLat && currLng === prevLng) continue;

    const dist = haversineMeters(prevLat, prevLng, currLat, currLng);

    // Filtra jitter GPS: descarta pontos sem deslocamento real
    if (dist < MIN_MOVE_DISTANCE_METERS) continue;

    const currBearing = bearing(prevLat, prevLng, currLat, currLng);

    // Mantém ponto se houve mudança de direção relevante (curva, conversão)
    if (prevBearing !== null) {
      const diff = headingDiff(prevBearing, currBearing);
      if (diff >= MIN_HEADING_CHANGE_DEGREES) {
        result.push(curr);
        prevBearing = currBearing;
        continue;
      }
    }

    // Mantém ponto mesmo sem curva se a distância for suficiente
    // para evitar lacunas visuais em trechos retos (rodovias, avenidas)
    if (dist >= STRAIGHT_LINE_KEEP_DISTANCE_METERS) {
      result.push(curr);
    }

    prevBearing = currBearing;
  }

  // Sempre inclui o último ponto para fechar a rota
  result.push(sorted[sorted.length - 1]);

  return result;
}

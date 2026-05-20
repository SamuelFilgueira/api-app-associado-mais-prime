import { HistoricoSegmentoDto } from '../dto/historico-response.dto';
import { RouteSegment, RouteSegmentPoint } from '../dto/historico-response.dto';

/**
 * Converte os segmentos de viagem do endpoint `/trajectories/by-keys`
 * no formato padronizado `RouteSegment` para o response `/rotas`.
 *
 * Reutiliza os dados já calculados pela Softruck (duração, distância,
 * velocidades) sem re-processar os pontos GPS brutos do endpoint geom,
 * evitando duplicação de lógica e inconsistências.
 *
 * Segmentos com distância ou duração zero são descartados (viagens inválidas
 * ou registros de ignição sem deslocamento real).
 *
 * @param segmentos - Segmentos mapeados a partir do by-keys
 * @returns Lista de segmentos no formato RouteSegment, ordenada por início
 */
export function buildRouteSegments(
  segmentos: HistoricoSegmentoDto[],
): RouteSegment[] {
  return segmentos
    .filter((s) => s.distanciaMetros > 0 && s.duracaoSegundos > 0)
    .map((s): RouteSegment => {
      const startTs = Date.parse(s.inicio.act);
      const endTs = Date.parse(s.fim.act);

      const startPoint: RouteSegmentPoint = {
        lat: s.inicio.lat,
        lng: s.inicio.lng,
        act: Math.floor(startTs / 1000),
        adr: s.inicio.adr,
      };

      const endPoint: RouteSegmentPoint = {
        lat: s.fim.lat,
        lng: s.fim.lng,
        act: Math.floor(endTs / 1000),
        adr: s.fim.adr,
      };

      return {
        startedAt: Math.floor(startTs / 1000),
        endedAt: Math.floor(endTs / 1000),
        durationSeconds: s.duracaoSegundos,
        distanceMeters: s.distanciaMetros,
        averageSpeed: s.velocidadeMedia,
        maxSpeed: s.velocidadeMaxima,
        startPoint,
        endPoint,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

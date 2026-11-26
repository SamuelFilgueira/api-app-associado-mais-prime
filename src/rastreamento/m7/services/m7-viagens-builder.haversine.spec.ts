import { M7ViagensBuilderService } from 'src/rastreamento/m7/services/m7-viagens-builder.service';
import { M7ReverseGeocodeService } from 'src/rastreamento/m7/services/m7-reverse-geocode.service';

/**
 * Distância usada pelo PDF V2 quando o odômetro não está disponível. A
 * conversão para radianos dividia por 40 em vez de 180 e inflava a distância
 * em 4,5 vezes.
 */
describe('M7ViagensBuilderService — distância de Haversine', () => {
  const service = new M7ViagensBuilderService({} as M7ReverseGeocodeService);
  const distanciaKm = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number =>
    (
      service as unknown as {
        calcularDistanciaHaversineKm: (
          a: number,
          b: number,
          c: number,
          d: number,
        ) => number;
      }
    ).calcularDistanciaHaversineKm(lat1, lon1, lat2, lon2);

  it('Rio de Janeiro → São Paulo ≈ 357 km em linha reta', () => {
    const km = distanciaKm(-22.9068, -43.1729, -23.5505, -46.6333);
    expect(km).toBeGreaterThan(350);
    expect(km).toBeLessThan(365);
  });

  it('um grau de latitude ≈ 111 km', () => {
    expect(distanciaKm(0, 0, 1, 0)).toBeCloseTo(111.19, 1);
  });

  it('mesmo ponto → 0', () => {
    expect(distanciaKm(-22.9, -43.1, -22.9, -43.1)).toBe(0);
  });
});

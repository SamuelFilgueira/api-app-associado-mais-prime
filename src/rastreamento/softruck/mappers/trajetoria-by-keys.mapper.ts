import {
  SoftruckByKeysData,
  SoftruckByKeysSegment,
} from '../interfaces/softruck-trajectories.interface';
import {
  HistoricoSegmentoDto,
  HistoricoSummaryDto,
  SegmentPointDto,
} from '../dto/historico-response.dto';

/**
 * Mapeia um ponto de início/fim de segmento (by-keys) para SegmentPointDto.
 */
function mapearPontoSegmento(
  ponto: SoftruckByKeysSegment['sta'],
): SegmentPointDto {
  return {
    act: ponto.act,
    lat: ponto.lat,
    lng: ponto.lng,
    adr: ponto.adr,
  };
}

/**
 * Mapeia um segmento individual da API Softruck (by-keys) para HistoricoSegmentoDto.
 *
 * @param segmento - Segmento bruto retornado pela Softruck
 * @param acc      - Data no formato YYYYMMDD do dia ao qual o segmento pertence
 */
export function mapearSegmentoByKeys(
  segmento: SoftruckByKeysSegment,
  acc: number,
): HistoricoSegmentoDto {
  return {
    id: segmento.id,
    acc,
    inicio: mapearPontoSegmento(segmento.sta),
    fim: mapearPontoSegmento(segmento.end),
    duracaoSegundos: segmento.dur,
    distanciaMetros: segmento.dis,
    velocidadeMaxima: segmento.spMax ?? 0,
    velocidadeMedia: segmento.spAvg ?? 0,
  };
}

/**
 * Extrai e mapeia todos os segmentos de um item de trajetória diária (by-keys).
 */
export function mapearSegmentosDoItem(
  item: SoftruckByKeysData,
): HistoricoSegmentoDto[] {
  const segs = item.attributes.segs ?? [];
  return segs.map((seg) => mapearSegmentoByKeys(seg, item.attributes.acc));
}

/**
 * Calcula o sumário consolidado a partir de uma lista de segmentos.
 *
 * A velocidade média geral é ponderada pela distância de cada segmento
 * para refletir com mais precisão o comportamento de condução no período.
 */
export function calcularSumario(
  segmentos: HistoricoSegmentoDto[],
  diasComDados: number,
): HistoricoSummaryDto {
  if (segmentos.length === 0) {
    return {
      totalSegmentos: 0,
      distanciaTotalMetros: 0,
      duracaoTotalSegundos: 0,
      velocidadeMaximaGeral: 0,
      velocidadeMediaGeral: 0,
      diasComDados,
    };
  }

  const distanciaTotal = segmentos.reduce(
    (acc, s) => acc + s.distanciaMetros,
    0,
  );

  const duracaoTotal = segmentos.reduce((acc, s) => acc + s.duracaoSegundos, 0);

  const velocidadeMaxima = Math.max(
    ...segmentos.map((s) => s.velocidadeMaxima),
  );

  // Velocidade média ponderada pela distância
  const somaPeso = segmentos.reduce(
    (acc, s) => acc + s.velocidadeMedia * s.distanciaMetros,
    0,
  );
  const velocidadeMedia =
    distanciaTotal > 0 ? parseFloat((somaPeso / distanciaTotal).toFixed(1)) : 0;

  return {
    totalSegmentos: segmentos.length,
    distanciaTotalMetros: distanciaTotal,
    duracaoTotalSegundos: duracaoTotal,
    velocidadeMaximaGeral: velocidadeMaxima,
    velocidadeMediaGeral: velocidadeMedia,
    diasComDados,
  };
}

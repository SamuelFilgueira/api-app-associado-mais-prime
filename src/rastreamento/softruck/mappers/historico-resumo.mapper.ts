import { Logger } from '@nestjs/common';
import {
  SoftruckByKeysData,
  SoftruckByKeysSegment,
  SoftruckGeomFeature,
} from '../interfaces/softruck-trajectories.interface';
import {
  DiaItemEventoDto,
  DiaItemTrajetoDto,
  DiaResumoDto,
  DiaResumoItemDto,
  PontoSegmentoResumoDto,
  ResumoSummaryDto,
  isTrajeto,
} from '../dto/historico-resumo-response.dto';
import { converterAccParaData } from '../utils/period.utils';
import { mapGeomFeaturesToEventos } from './softruck-event.mapper';

// ============================================================
// Mappers internos — trajeto
// ============================================================

/**
 * Converte um ponto bruto (sta ou end de um segmento) para o formato resumo.
 * Omite lat/lng — o frontend os obterá via /geom sob demanda.
 */
function mapearPontoResumo(
  ponto: SoftruckByKeysSegment['sta'],
): PontoSegmentoResumoDto {
  return {
    act: ponto.act,
    adr: ponto.adr,
  };
}

/**
 * Converte um segmento bruto da Softruck para `DiaItemTrajetoDto`.
 */
function mapearSegmentoComoTrajeto(
  seg: SoftruckByKeysSegment,
): DiaItemTrajetoDto {
  return {
    kind: 'TRAJECTORY',
    trajetoId: seg.id,
    inicio: mapearPontoResumo(seg.sta),
    fim: mapearPontoResumo(seg.end),
    duracaoSegundos: seg.dur,
    distanciaMetros: seg.dis,
    velocidadeMedia: seg.spAvg ?? 0,
    velocidadeMaxima: seg.spMax ?? 0,
  };
}

// ============================================================
// Funções exportadas
// ============================================================

/**
 * Constrói a lista unificada de items (trajetos + eventos) para um dia.
 *
 * Fluxo:
 * 1. Extrai segmentos válidos do by-keys (dur > 0 e dis > 0)
 * 2. Extrai eventos válidos das features geom (filtra UNKNOWN e SHAKE_ALERT)
 * 3. Combina e ordena cronologicamente por timestamp
 *
 * @param byKeysData    - Dados brutos do endpoint /trajectories/by-keys
 * @param geomFeatures  - Features GeoJSON do endpoint /trajectories/geom (pode ser vazio)
 * @param logger        - Logger para registrar eventos ignorados / desconhecidos
 */
export function mapearDiaItems(
  byKeysData: SoftruckByKeysData,
  geomFeatures: SoftruckGeomFeature[],
  logger: Logger,
): DiaResumoDto {
  const { acc } = byKeysData.attributes;
  const enterpriseId = byKeysData.relationships?.enterprise?.id ?? '';

  // ── Trajetos ──────────────────────────────────────────────
  const segmentosValidos = (byKeysData.attributes.segs ?? []).filter(
    (s) => s.dur > 0 && s.dis > 0,
  );
  const trajetos: DiaItemTrajetoDto[] = segmentosValidos.map(
    mapearSegmentoComoTrajeto,
  );

  // ── Eventos (alarmes) ─────────────────────────────────────
  const eventos = mapGeomFeaturesToEventos(geomFeatures, logger);

  // ── Merge e ordenação cronológica ─────────────────────────
  const items: DiaResumoItemDto[] = [...trajetos, ...eventos];
  items.sort((a, b) => {
    const tsA: string = isTrajeto(a)
      ? a.inicio.act
      : (a as DiaItemEventoDto).timestamp;
    const tsB: string = isTrajeto(b)
      ? b.inicio.act
      : (b as DiaItemEventoDto).timestamp;
    return tsA < tsB ? -1 : tsA > tsB ? 1 : 0;
  });

  return {
    data: converterAccParaData(acc),
    acc,
    enterpriseId,
    items,
  };
}

/**
 * Calcula o sumário consolidado a partir dos dias com dados.
 *
 * @param dias - Dias mapeados que possuem pelo menos um item
 */
export function calcularResumoSummary(dias: DiaResumoDto[]): ResumoSummaryDto {
  let totalSegmentos = 0;
  let totalEventos = 0;
  let distanciaTotalMetros = 0;
  let duracaoTotalSegundos = 0;

  for (const dia of dias) {
    for (const item of dia.items) {
      if (isTrajeto(item)) {
        totalSegmentos++;
        distanciaTotalMetros += item.distanciaMetros;
        duracaoTotalSegundos += item.duracaoSegundos;
      } else {
        totalEventos++;
      }
    }
  }

  return {
    diasComDados: dias.length,
    totalSegmentos,
    totalEventos,
    distanciaTotalMetros,
    duracaoTotalSegundos,
  };
}

/**
 * @deprecated Use `mapearDiaItems` diretamente.
 * Mantido para retrocompatibilidade com testes unitários existentes.
 */
export function mapearDiaResumo(item: SoftruckByKeysData): DiaResumoDto {
  return mapearDiaItems(item, [], new Logger('mapearDiaResumo'));
}

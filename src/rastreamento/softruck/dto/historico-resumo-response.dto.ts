import { VehicleInfoDto, PeriodInfoDto } from './historico-response.dto';
import {
  SoftruckEventCategory,
  SoftruckEventSeverity,
  SoftruckEventType,
} from '../enums/softruck-event-type.enum';

// ============================================================
// Items do tipo TRAJECTORY (trajeto)
// ============================================================

/**
 * Ponto de início ou fim de um trajeto (versão resumo — apenas act e adr).
 * Não inclui lat/lng — o frontend usará `/geom` para detalhamento de mapa.
 */
export interface PontoSegmentoResumoDto {
  /** Timestamp ISO 8601 do evento */
  act: string;
  /** Endereço textual do local (pode estar ausente) */
  adr?: string;
}

/** Item do tipo trajeto — representa um trecho de viagem completo */
export interface DiaItemTrajetoDto {
  /** Discriminador de tipo para o frontend */
  kind: 'TRAJECTORY';
  /** ID do segmento — correlaciona com /geom posteriormente */
  trajetoId: string;
  inicio: PontoSegmentoResumoDto;
  fim: PontoSegmentoResumoDto;
  /** Duração do segmento em segundos */
  duracaoSegundos: number;
  /** Distância percorrida em metros */
  distanciaMetros: number;
  /** Velocidade média em km/h */
  velocidadeMedia: number;
  /** Velocidade máxima em km/h */
  velocidadeMaxima: number;
}

// ============================================================
// Items do tipo EVENT (alarme/evento)
// ============================================================

/** Coordenadas geográficas de um evento */
export interface CoordenadaEventoDto {
  lat: number;
  lng: number;
}

/** Item do tipo evento — representa um alarme ou ocorrência do dispositivo */
export interface DiaItemEventoDto {
  /** Discriminador de tipo para o frontend */
  kind: 'EVENT';
  /**
   * Tipo normalizado do evento.
   * O frontend NÃO precisa interpretar tag/val/msg brutos.
   */
  tipo: SoftruckEventType;
  /** Descrição amigável em português */
  descricao: string;
  /** Classificação de alto nível do evento */
  categoria: SoftruckEventCategory;
  /** Nível de urgência do evento */
  severidade: SoftruckEventSeverity;
  /** Timestamp ISO 8601 do momento em que o evento ocorreu */
  timestamp: string;
  /** Localização geográfica do evento */
  coordenadas: CoordenadaEventoDto;
}

// ============================================================
// Union type dos itens do dia
// ============================================================

/**
 * Item de um dia no histórico.
 * Discriminação pelo campo `kind`:
 * - `"TRAJECTORY"` → `DiaItemTrajetoDto`
 * - `"EVENT"`      → `DiaItemEventoDto`
 */
export type DiaResumoItemDto = DiaItemTrajetoDto | DiaItemEventoDto;

// ============================================================
// Dia completo
// ============================================================

/** Dados de um dia do período que contém ao menos um item (trajeto ou evento) */
export interface DiaResumoDto {
  /** Data no formato ISO: "2026-05-02" */
  data: string;
  /** Data no formato ACC Softruck: 20260502 — usar para chamar /geom */
  acc: number;
  /**
   * ID da empresa na Softruck para o dia.
   * Necessário como `filters[eid][eq]` ao buscar detalhes via /geom.
   */
  enterpriseId: string;
  /**
   * Itens do dia, ordenados cronologicamente.
   * Inclui trajetos (`TRAJECTORY`) e eventos válidos (`EVENT`).
   * SHAKE_ALERT e UNKNOWN são removidos antes de retornar.
   */
  items: DiaResumoItemDto[];
}

// ============================================================
// Sumário do período
// ============================================================

/** Métricas consolidadas de todos os dias com dados */
export interface ResumoSummaryDto {
  /** Número de dias no período que tiveram ao menos um item */
  diasComDados: number;
  /** Total de trajetos (kind=TRAJECTORY) no período */
  totalSegmentos: number;
  /** Total de eventos válidos (kind=EVENT) no período */
  totalEventos: number;
  /** Somatório da distância de todos os trajetos em metros */
  distanciaTotalMetros: number;
  /** Somatório da duração de todos os trajetos em segundos */
  duracaoTotalSegundos: number;
}

// ============================================================
// Response completo do endpoint /resumo
// ============================================================

export interface HistoricoResumoResponseDto {
  /** Dados do veículo consultado */
  vehicle: VehicleInfoDto;
  /** Informações do período consultado */
  period: PeriodInfoDto;
  /** Totais consolidados do período */
  summary: ResumoSummaryDto;
  /**
   * Dias que possuem dados.
   * Dias sem trajetos e sem eventos são silenciosamente omitidos.
   */
  dias: DiaResumoDto[];
}

// ============================================================
// Type guards
// ============================================================

/** Verifica em tempo de execução se um item é um trajeto */
export function isTrajeto(item: DiaResumoItemDto): item is DiaItemTrajetoDto {
  return item.kind === 'TRAJECTORY';
}

/** Verifica em tempo de execução se um item é um evento */
export function isEvento(item: DiaResumoItemDto): item is DiaItemEventoDto {
  return item.kind === 'EVENT';
}

// ============================================================
// Alias de compatibilidade
// ============================================================

/**
 * @deprecated Use `DiaItemTrajetoDto` diretamente.
 * Mantido para não quebrar referências internas existentes.
 */
export type SegmentoResumoDto = Omit<DiaItemTrajetoDto, 'kind'>;

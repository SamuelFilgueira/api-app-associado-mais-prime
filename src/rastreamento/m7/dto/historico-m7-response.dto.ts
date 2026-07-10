export interface VeiculoM7InfoDto {
  codigo: number;
  placa: string;
  chassi: string;
}

export interface PeriodoM7Dto {
  dataInicial: string;
  dataFinal: string;
}

export interface HistoricoM7PdfDataDto {
  veiculo: VeiculoM7InfoDto;
  periodo: PeriodoM7Dto;
  resumo: ResumoM7SummaryDto;
  dias: DiaM7ResumoDto[];
}

export interface HistoricoM7ContestacaoPontoDto {
  placa: string;
  dataGps: string;
  velocidade: number;
  endereco: string;
  latitude: string;
  longitude: string;
}

export interface HistoricoM7ContestacaoPdfDataDto {
  veiculo: VeiculoM7InfoDto;
  periodo: PeriodoM7Dto;
  pontos: HistoricoM7ContestacaoPontoDto[];
}

export interface HistoricoM7RotasPontoDto {
  latitude: number;
  longitude: number;
  velocidade: number;
  ignicao: boolean;
  dataGps: string;
}

export interface HistoricoM7RotasResponseDto {
  veiculo: VeiculoM7InfoDto;
  periodo: PeriodoM7Dto;
  totalPontos: number;
  pontos: HistoricoM7RotasPontoDto[];
}

// ---------------------------------------------------------------------------
// Resumo — modelo PARADO → VIAGEM → PARADO
// ---------------------------------------------------------------------------

/**
 * Uma viagem válida derivada do par (PARADO anterior + VIAGEM).
 * - `origem`  = campo `destino` do registro PARADO que precedeu a viagem.
 * - `saida`   = `data_fim` do PARADO (= `data_inicio` da VIAGEM).
 * - `destino` = campo `destino` do registro VIAGEM.
 * - `chegada` = `data_fim` da VIAGEM.
 * - `distanciaKm` = campo `distancia` da API (já em km).
 */
export interface ViagemM7Dto {
  origem: string;
  saida: string;
  destino: string;
  chegada: string;
  distanciaKm: number;
  tempoMovimento: string;
  tempoParado?: string;
  tempoTotal?: string;
  velocidadeMaxima: number;
}

/** Dados de um dia agrupado no resumo M7 (agrupado pela data de saída) */
export interface DiaM7ResumoDto {
  /** Data no formato ISO: "2026-05-02" */
  data: string;
  /** Viagens válidas do dia */
  viagens: ViagemM7Dto[];
  /** Somatório da distância das viagens do dia em km */
  distanciaTotalKm: number;
}

/** Sumário consolidado do período */
export interface ResumoM7SummaryDto {
  /** Dias que tiveram ao menos uma viagem válida */
  diasComDados: number;
  /** Total de viagens válidas no período */
  totalViagens: number;
  /** Distância total percorrida em km */
  distanciaTotalKm: number;
  /** Velocidade máxima registrada no período */
  velocidadeMaxima: number;
}

export interface HistoricoM7ResumoResponseDto {
  veiculo: VeiculoM7InfoDto;
  periodo: PeriodoM7Dto;
  resumo: ResumoM7SummaryDto;
  /** Dias com ao menos uma viagem, ordenados cronologicamente */
  dias: DiaM7ResumoDto[];
}

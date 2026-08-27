/** Corpo enviado a POST /listar/boleto-associado/periodo. */
export interface SgaBoletoPeriodoRequest {
  data_vencimento_original_inicial: string;
  data_vencimento_original_final: string;
  codigo_situacao_boleto: number;
  quantidade_por_pagina: number;
  inicio_paginacao: number;
}

/** Veículo embutido em cada boleto (campos usados pela rotina). */
export interface SgaBoletoVeiculo {
  codigo_veiculo?: number | string;
  placa?: string;
  codigo_regional?: string | number;
  situacao_veiculo?: string;
  [key: string]: unknown;
}

/** Boleto normalizado a partir do retorno bruto do SGA. */
export interface SgaBoletoPeriodo {
  nossoNumero: string;
  codigoAssociado: number | null;
  nomeAssociado: string;
  cpf: string;
  dataVencimento: string;
  dataVencimentoOriginal: string;
  codigoSituacaoBoleto: string;
  situacaoBoleto: string;
  valorBoleto: string;
  mesReferente: string;
  veiculos: SgaBoletoVeiculo[];
}

/** Metadados de paginação normalizados de uma página. */
export interface SgaBoletoPeriodoPagina {
  boletos: SgaBoletoPeriodo[];
  mostrando: number;
  numeroPaginas: number;
  totalRegistros: number;
  paginaCorrente: number;
}

/** Resultado consolidado da consulta paginada. */
export interface SgaBoletoPeriodoResultado {
  boletos: SgaBoletoPeriodo[];
  totalRegistros: number;
  numeroPaginas: number;
  paginasConsultadas: number;
  duplicadosEntrePaginas: number;
  origem: 'SGA' | 'MOCK';
}

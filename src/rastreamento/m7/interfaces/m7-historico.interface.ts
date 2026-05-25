// ---------------------------------------------------------------------------
// Interfaces para respostas brutas da API M7 (historico modular)
// ---------------------------------------------------------------------------

/** Resposta do POST /api/veiculos/consulta */
export interface M7ConsultaVeiculoResponse {
  veiculo: {
    codigo: number;
    placa: string;
    chassi: string;
  };
  cliente: {
    codigo: number;
  };
}

/** Item bruto retornado pelo GET /api/monitorado/{codigo}/trajetos */
export interface M7TrajetoRaw {
  id?: number | string;
  tipo?: string;
  data_inicio?: string;
  data_fim?: string;
  tempo_movimento?: string;
  tempo_parado?: string;
  tempo_total?: string;
  distancia?: number | string;
  velocidade_maxima?: number | string;
  destino?: string;
}

/** Ponto GPS bruto do GET /api/historico/{inicio}/{fim}/{codigo} */
export interface M7PontoHistoricoRaw {
  codigo_posicao?: number;
  identificador?: string;
  monitorado?: number;
  data_gps?: string;
  cidade?: string;
  latitude?: number | string;
  longitude?: number | string;
  velocidade?: number | string;
  ignicao?: boolean | number | string;
  tensao?: string;
  bateria?: string;
}

/** Wrapper retornado pela API de historico GPS */
export interface M7HistoricoApiResponse {
  historico?: M7PontoHistoricoRaw[];
}

/** Wrapper retornado pela API de trajetos */
export interface M7TrajetosApiResponse {
  trajetos?: M7TrajetoRaw[];
}

export interface TrajetoResponse {
  clienteNome: string;
  relatorio: TrajetoRelatorio;
  quantidadeTotal: number;
  logado: boolean;
}

export interface TrajetoRelatorio {
  paradas: TrajetoParada[];
  posicoes: TrajetoPosicao[];
  resumo: TrajetoResumo;
  eventoMotorista: unknown[];
}

export interface TrajetoParada {
  tecladoEvento: string | null;
  tipo: string;

  enderecoNumero: string;
  enderecoEndereco: string;
  enderecoBairro: string;
  enderecoCidade: string;
  enderecoEstado: string;
  endereco: string;

  enderecoNumeroFim: string;
  enderecoEnderecoFim: string;
  enderecoBairroFim: string;
  enderecoCidadeFim: string;
  enderecoEstadoFim: string;

  data: string;
  dataInicio: string;
  dataFim: string;
  tempo: string;

  latitude: number;
  longitude: number;
  latitudeFim: number | null;
  longitudeFim: number | null;

  velocidade: number;
  direcao: string;

  bateria: number;
  bateriaEquipamento: number;
  satelite: number;

  ignicao: string;

  equipamentoId: number;
  equipamentoCodigo: string;
  veiculoId: number;

  placa: string;
  motoristaNome: string | null;

  entradas: string;
  saidas: string;
  portaEntrada: string;
  portaSaida: string;

  imagem: string;

  id: number;
  i: number;
}

export interface TrajetoPosicao {
  tecladoEvento: string | null;
  eventoNome: string | null;

  enderecoNumero: string;
  enderecoEndereco: string;
  enderecoBairro: string;
  enderecoCidade: string;
  enderecoEstado: string;
  endereco: string;

  data: string;
  dataTz: number;

  latitude: number;
  longitude: number;

  velocidade: number;
  direcao: string;

  bateria: number;
  bateriaEquipamento: number;
  satelite: number;

  ignicao: string;

  equipamentoId: number;
  equipamentoCodigo: string;
  veiculoId: number;

  placa: string;
  motoristaNome: string | null;

  entradas: string;
  saidas: string;
  portaEntrada: string;
  portaSaida: string;

  imagem: string;

  id: number;
  i: number;
}

export interface TrajetoResumo {
  tempoMotorOcioso: string;
  tempoParado: string | null;
  tempoMovimento: string | null;
  tempoIgnicaoLigada: string;

  velocidadeMaxima: number;
  velocidadeMedia: number;
  velocidadeMinima: number;

  distanciaTotal: number;

  quantidadeParada: number | null;
  quantidadeDeslocamento: number | null;

  bateriaEquipamentoMedia: number | null;
  bateriaEquipamentoMinima: number | null;
  bateriaEquipamentoMaxima: number | null;

  bateriaVeiculoMedia: number | null;
  bateriaVeiculoMinima: number | null;
  bateriaVeiculoMaxima: number | null;
}
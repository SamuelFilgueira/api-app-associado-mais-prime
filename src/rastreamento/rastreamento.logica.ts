import axios from 'axios';

export interface UltimaPosicaoLogicaResponse {
  oIgnicao: boolean;
  placa: string | null;
  condutorNome: string | null;
  modelo: string;
  marca: string;
  alertaIgnicao: boolean;
  cidade: string;
  estado: string;
  latitude: number;
  ultimaTrasmissao: string;
  direcao: string;
  longitude: number;
  ignicao: string;
  hodometro: number;
  velocidade: number;
  voltagem: number;
}

export async function ultimaPosicaoLogica(
  chassi: string,
): Promise<UltimaPosicaoLogicaResponse> {
  const token = process.env.LOGICA_TOKEN;
  if (!token) {
    throw new Error('LOGICA_TOKEN não definido nas variáveis de ambiente');
  }

  const params = new URLSearchParams();
  params.append('chassi', chassi);
  params.append('token', token);

  const response = await axios.post(
    `${process.env.LOGICA_API_BASE_URL}listaVeiculo`,
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );

  const data = response.data;
  if (!data.lista || !Array.isArray(data.lista) || data.lista.length === 0) {
    throw new Error('Nenhum veículo encontrado para o chassi informado');
  }

  const item = data.lista[0];
  const ultimaPosicao = item.ultimaPosicao || {};

  return {
    oIgnicao: item.oIgnicao,
    placa: item.placa || null,
    marca: item.marca,
    condutorNome: item.condutorNome,
    modelo: item.modelo,
    alertaIgnicao: item.alertaIgnicao,
    cidade: ultimaPosicao.cidade,
    estado: ultimaPosicao.estado,
    ultimaTrasmissao: ultimaPosicao.ultimaTrasmissao,
    latitude: ultimaPosicao.latitude,
    direcao: ultimaPosicao.direcao,
    longitude: ultimaPosicao.longitude,
    ignicao: ultimaPosicao.ignicao,
    hodometro: ultimaPosicao.hodometro,
    velocidade: ultimaPosicao.velocidade,
    voltagem: ultimaPosicao.voltagem,
  };
}

import axios from 'axios';
import {
  Logger,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

/**
 * Agora a função aceita um token (resolvido pelo TokenResolver) para suportar multi-tenant.
 * Se `token` não for fornecido, ela tentará usar `process.env.LOGICA_TOKEN` (compatibilidade).
 */
const logger = new Logger('RastreamentoLogica');

/** Cache em memória para token dinâmico por base */
const LOGICA_TOKEN_CACHE = new Map<string, string>();

/** Timeout padrão para chamadas HTTP à API Lógica Soluções (em ms) */
const LOGICA_REQUEST_TIMEOUT = 15_000;

export interface UltimaPosicaoLogicaResponse {
  oIgnicao: boolean;
  placa: string | null;
  condutorNome: string | null;
  modelo: string;
  marca: string;
  alertaIgnicao: boolean;
  cidade: string;
  endereco: string;
  bairro: string;
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

interface LogicaAuthResponse {
  erro?: boolean;
  logado?: boolean;
  token?: string;
  mensagem?: string;
}

interface LogicaUltimaPosicaoPayload {
  cidade: string;
  endereco: string;
  bairro: string;
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

interface LogicaListaItemPayload {
  oIgnicao: boolean;
  placa: string | null;
  condutorNome: string | null;
  modelo: string;
  marca: string;
  alertaIgnicao: boolean;
  ultimaPosicao?: LogicaUltimaPosicaoPayload;
}

interface LogicaListaResponsePayload {
  lista?: LogicaListaItemPayload[];
  [key: string]: unknown;
}

function maskSecret(value?: string): string {
  if (!value) return '(vazio)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function buildLogicaUrl(path: string): string {
  const baseUrl = process.env.LOGICA_API_BASE_URL;

  if (!baseUrl) {
    throw new InternalServerErrorException(
      'LOGICA_API_BASE_URL não definida nas variáveis de ambiente',
    );
  }

  const normalizedBaseUrl = baseUrl.endsWith('/')
    ? baseUrl.slice(0, -1)
    : baseUrl;

  return `${normalizedBaseUrl}/${path.replace(/^\//, '')}`;
}

function isTokenInvalidResponse(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;

  const value = data as Record<string, unknown>;
  const logado = value.logado;
  const erro = value.erro;
  const mensagem =
    typeof value.mensagem === 'string' ? value.mensagem.toLowerCase() : '';

  if (logado === false || erro === true) return true;
  if (
    mensagem.includes('token') &&
    (mensagem.includes('inv') || mensagem.includes('expir'))
  ) {
    return true;
  }

  return false;
}

async function autenticarLogica(baseOrigin?: string): Promise<string> {
  const apiNumber = process.env.LOGICA_API_NUMBER;
  if (!apiNumber) {
    throw new InternalServerErrorException(
      'LOGICA_API_NUMBER não definido nas variáveis de ambiente',
    );
  }

  const authUrl = buildLogicaUrl('/autentica');
  const params = new URLSearchParams();
  params.append('usuario', apiNumber);
  params.append('senha', apiNumber);

  const response = await axios.post<LogicaAuthResponse>(authUrl, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: LOGICA_REQUEST_TIMEOUT,
  });

  const authData = response.data;
  const refreshedToken = authData?.token;

  if (
    !refreshedToken ||
    authData?.erro === true ||
    authData?.logado === false
  ) {
    logger.error(
      `Falha ao autenticar na Lógica baseOrigin=${baseOrigin ?? 'N/A'} status=${response.status} body=${JSON.stringify(authData)}`,
    );
    throw new InternalServerErrorException(
      'Falha ao autenticar na API Lógica para renovação de token',
    );
  }

  const cacheKey = baseOrigin ?? 'default';
  LOGICA_TOKEN_CACHE.set(cacheKey, refreshedToken);
  logger.log(
    `Token da Lógica renovado com sucesso baseOrigin=${baseOrigin ?? 'N/A'} token=${maskSecret(refreshedToken)}`,
  );

  return refreshedToken;
}

async function consultarListaVeiculo(
  chassi: string,
  token: string,
): Promise<unknown> {
  const params = new URLSearchParams();
  params.append('chassi', chassi);
  params.append('token', token);

  const requestUrl = buildLogicaUrl('/listaVeiculo');
  const response = await axios.post(requestUrl, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: LOGICA_REQUEST_TIMEOUT,
  });

  return response.data;
}

export async function ultimaPosicaoLogica(
  chassi: string,
  token?: string,
  context?: {
    baseOrigin?: string;
    tokenKey?: string;
  },
): Promise<UltimaPosicaoLogicaResponse> {
  const cacheKey = context?.baseOrigin ?? 'default';
  const normalizedChassi = chassi?.trim();

  if (!normalizedChassi) {
    throw new NotFoundException('Chassi não informado para consulta na Lógica');
  }

  const usedToken =
    LOGICA_TOKEN_CACHE.get(cacheKey) ?? token ?? process.env.LOGICA_TOKEN;
  if (!usedToken) {
    logger.error('LOGICA token não fornecido nem presente em env');
    throw new InternalServerErrorException(
      'LOGICA_TOKEN não definido nas variáveis de ambiente',
    );
  }

  logger.debug(
    `Consultando Lógica para chassi=${normalizedChassi} baseOrigin=${context?.baseOrigin ?? 'N/A'} tokenKey=${context?.tokenKey ?? 'LOGICA_TOKEN'} token=${maskSecret(usedToken)} (tokenProvided=${!!token})`,
  );

  let data: unknown;
  try {
    data = await consultarListaVeiculo(normalizedChassi, usedToken);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logger.error(
        `Falha HTTP na Lógica chassi=${normalizedChassi} url=${error.config?.url ?? 'N/A'} status=${error.response?.status ?? 'N/A'} body=${JSON.stringify(error.response?.data ?? null)}`,
      );
    }
    throw error;
  }

  if (isTokenInvalidResponse(data)) {
    logger.warn(
      `Token da Lógica inválido/expirado para baseOrigin=${context?.baseOrigin ?? 'N/A'}. Tentando nova autenticação.`,
    );

    const refreshedToken = await autenticarLogica(context?.baseOrigin);
    data = await consultarListaVeiculo(normalizedChassi, refreshedToken);
  }

  const parsedData = data as LogicaListaResponsePayload;

  if (
    !parsedData.lista ||
    !Array.isArray(parsedData.lista) ||
    parsedData.lista.length === 0
  ) {
    logger.warn(
      `Resposta sem lista válida da Lógica para chassi=${normalizedChassi}: ${JSON.stringify(parsedData)}`,
    );
    throw new NotFoundException(
      'Nenhum veículo encontrado para o chassi informado',
    );
  }

  const item = parsedData.lista[0];
  const ultimaPosicao: LogicaUltimaPosicaoPayload =
    item.ultimaPosicao ?? ({} as LogicaUltimaPosicaoPayload);

  return {
    oIgnicao: item.oIgnicao,
    placa: item.placa || null,
    marca: item.marca,
    condutorNome: item.condutorNome,
    modelo: item.modelo,
    alertaIgnicao: item.alertaIgnicao,

    cidade: ultimaPosicao.cidade,
    estado: ultimaPosicao.estado,

    endereco: ultimaPosicao.endereco,
    bairro: ultimaPosicao.bairro,

    ultimaTrasmissao: ultimaPosicao.ultimaTrasmissao,
    latitude: ultimaPosicao.latitude,
    longitude: ultimaPosicao.longitude,
    direcao: ultimaPosicao.direcao,
    ignicao: ultimaPosicao.ignicao,
    hodometro: ultimaPosicao.hodometro,
    velocidade: ultimaPosicao.velocidade,
    voltagem: ultimaPosicao.voltagem,
  };
}

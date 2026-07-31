import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { maskSecret } from 'src/shared/log.util';
import {
  IRastreamentoProvider,
  RastreamentoBaseContext,
  RastreamentoCandidatoResult,
} from 'src/rastreamento/providers/rastreamento-provider.interface';

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
  numero: string;
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

@Injectable()
export class LogicaRastreamentoService implements IRastreamentoProvider {
  private readonly logger = new Logger(LogicaRastreamentoService.name);
  readonly providerName = 'logica' as const;

  /** Cache em memória para token dinâmico por base — gerenciado no escopo da instância */
  private readonly tokenCache = new Map<string, string>();

  // -------------------------------------------------------------------------
  // IRastreamentoProvider
  // -------------------------------------------------------------------------

  async obterUltimaPosicao(params: {
    cnpj: string;
    chassi: string;
    baseContext: RastreamentoBaseContext;
  }): Promise<RastreamentoCandidatoResult> {
    const { chassi, baseContext } = params;
    const data = await this.ultimaPosicao(chassi, baseContext.logicaToken, {
      baseOrigin: baseContext.baseOrigin,
      tokenKey: baseContext.logicaTokenKey,
    });
    return {
      dataOriginal: data.ultimaTrasmissao,
      timestamp: this.parseDateToTimestamp(data.ultimaTrasmissao),
      data: data as unknown as Record<string, unknown>,
      origem: 'logica',
    };
  }

  // -------------------------------------------------------------------------
  // Consulta principal
  // -------------------------------------------------------------------------

  async ultimaPosicao(
    chassi: string,
    token?: string,
    context?: { baseOrigin?: string; tokenKey?: string },
  ): Promise<UltimaPosicaoLogicaResponse> {
    const cacheKey = context?.baseOrigin ?? 'default';
    const normalizedChassi = chassi?.trim();

    if (!normalizedChassi) {
      throw new NotFoundException('Chassi não informado para consulta na Lógica');
    }

    const usedToken =
      this.tokenCache.get(cacheKey) ?? token ?? process.env.LOGICA_TOKEN;
    if (!usedToken) {
      this.logger.error('LOGICA token não fornecido nem presente em env');
      throw new InternalServerErrorException('LOGICA_TOKEN não definido nas variáveis de ambiente');
    }

    let data: unknown;
    try {
      data = await this.consultarListaVeiculo(normalizedChassi, usedToken);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Falha HTTP na Lógica chassi=${normalizedChassi} url=${error.config?.url ?? 'N/A'} status=${error.response?.status ?? 'N/A'} body=${JSON.stringify(error.response?.data ?? null)}`,
        );
      }
      throw error;
    }

    if (this.isTokenInvalidResponse(data)) {
      this.logger.warn(
        `Token da Lógica inválido/expirado para baseOrigin=${context?.baseOrigin ?? 'N/A'}. Tentando nova autenticação.`,
      );
      const refreshedToken = await this.autenticar(context?.baseOrigin);
      data = await this.consultarListaVeiculo(normalizedChassi, refreshedToken);
    }

    const parsedData = data as LogicaListaResponsePayload;

    if (!parsedData.lista || !Array.isArray(parsedData.lista) || parsedData.lista.length === 0) {
      this.logger.warn(
        `Resposta sem lista válida da Lógica para chassi=${normalizedChassi}: ${JSON.stringify(parsedData)}`,
      );
      throw new NotFoundException('Nenhum veículo encontrado para o chassi informado');
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
      endereco: ultimaPosicao.endereco + (ultimaPosicao.numero ? `, ${ultimaPosicao.numero}` : ''),
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

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private async consultarListaVeiculo(chassi: string, token: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.append('chassi', chassi);
    params.append('token', token);

    const response = await axios.post(this.buildUrl('/listaVeiculo'), params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: LOGICA_REQUEST_TIMEOUT,
    });

    this.logger.debug(`Resposta da Lógica para chassi=${chassi}: status=${response.status} body=${JSON.stringify(response.data)}`);
    return response.data;
  }

  private async autenticar(baseOrigin?: string): Promise<string> {
    const apiNumber = process.env.LOGICA_API_NUMBER;
    if (!apiNumber) {
      throw new InternalServerErrorException('LOGICA_API_NUMBER não definido nas variáveis de ambiente');
    }

    const params = new URLSearchParams();
    params.append('usuario', apiNumber);
    params.append('senha', apiNumber);

    const response = await axios.post<LogicaAuthResponse>(
      this.buildUrl('/autentica'),
      params,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: LOGICA_REQUEST_TIMEOUT,
      },
    );

    const authData = response.data;
    const refreshedToken = authData?.token;

    if (!refreshedToken || authData?.erro === true || authData?.logado === false) {
      this.logger.error(
        `Falha ao autenticar na Lógica baseOrigin=${baseOrigin ?? 'N/A'} status=${response.status} body=${JSON.stringify(authData)}`,
      );
      throw new InternalServerErrorException('Falha ao autenticar na API Lógica para renovação de token');
    }

    const cacheKey = baseOrigin ?? 'default';
    this.tokenCache.set(cacheKey, refreshedToken);
    this.logger.log(
      `Token da Lógica renovado com sucesso baseOrigin=${baseOrigin ?? 'N/A'} token=${maskSecret(refreshedToken)}`,
    );

    return refreshedToken;
  }

  private buildUrl(path: string): string {
    const baseUrl = process.env.LOGICA_API_BASE_URL;

    if (!baseUrl) {
      throw new InternalServerErrorException('LOGICA_API_BASE_URL não definida nas variáveis de ambiente');
    }

    const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${normalized}/${path.replace(/^\//, '')}`;
  }

  private isTokenInvalidResponse(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;

    const value = data as Record<string, unknown>;
    const logado = value.logado;
    const erro = value.erro;
    const mensagem =
      typeof value.mensagem === 'string' ? value.mensagem.toLowerCase() : '';

    if (logado === false || erro === true) return true;
    if (mensagem.includes('token') && (mensagem.includes('inv') || mensagem.includes('expir'))) {
      return true;
    }

    return false;
  }

  private parseDateToTimestamp(dateValue: string): number {
    const dateTrimmed = dateValue?.trim() ?? '';
    const parsedNative = Date.parse(dateTrimmed.replace(' ', 'T'));
    if (!Number.isNaN(parsedNative)) return parsedNative;

    const brDateMatch = dateTrimmed.match(
      /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (brDateMatch) {
      const [, day, month, year, hour, minute, second] = brDateMatch;
      const parsed = new Date(
        Number(year), Number(month) - 1, Number(day),
        Number(hour), Number(minute), Number(second ?? '0'),
      ).getTime();
      if (!Number.isNaN(parsed)) return parsed;
    }

    return 0;
  }
}

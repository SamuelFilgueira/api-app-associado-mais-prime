import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { TokenResolverService } from '../../shared/token-resolver.service';
import { BaseOrigin } from '../../config/tenant.config';
import {
  ClubgasErro,
  ClubgasOperacao,
  clubgasErroDeCorpo,
  clubgasErroDeFalha,
} from './clubgas.erro';

export interface ClubgasPostosResponse {
  result: unknown[];
  /** Vem `null` quando o Clubgas não aceita a placa (ver `postosRecusadosPelaPlaca`). */
  pagination?: unknown;
}

/** Tempo máximo de espera pelo Clubgas (as chamadas normais levam cerca de 2 s). */
const CLUBGAS_TIMEOUT_MS = 15_000;

/**
 * A listagem de postos nunca responde com erro: para uma placa fora do formato
 * aceito o Clubgas devolve 200 com `result: []` e `pagination: null`. Com placa
 * aceita a paginação vem preenchida, mesmo longe de qualquer posto.
 */
export function postosRecusadosPelaPlaca(
  resposta: ClubgasPostosResponse | null | undefined,
): boolean {
  if (!resposta) return false;
  const semPostos =
    !Array.isArray(resposta.result) || resposta.result.length === 0;
  return semPostos && resposta.pagination === null;
}

/**
 * Client HTTP da API ClubGas. Único ponto da aplicação que conhece a URL
 * e resolve o token da integração por base (multi-tenant).
 *
 * Toda falha sai daqui como `ClubgasErro`, já classificada: recusa do Clubgas
 * (4xx com a mensagem dele), erro interno, timeout, falta de conexão ou
 * resposta fora do contrato. Quem chama registra e converte em resposta HTTP
 * com `ClubgasErroLogService.tratar`.
 */
@Injectable()
export class ClubgasClient {
  private readonly baseUrl =
    process.env.CLUBGAS_BASE_URL ??
    'https://clubgas-api.azurewebsites.net/api/v1';

  constructor(private readonly tokenResolver: TokenResolverService) {}

  private resolverToken(
    baseOrigin: BaseOrigin,
    operacao: ClubgasOperacao,
  ): string {
    try {
      return this.tokenResolver.resolveClubgasToken(baseOrigin);
    } catch (falha) {
      throw new ClubgasErro({
        operacao,
        categoria: 'CONFIGURACAO',
        mensagem: falha instanceof Error ? falha.message : String(falha),
      });
    }
  }

  private async get<T>(
    operacao: ClubgasOperacao,
    caminho: string,
    params: Record<string, string | number>,
    token: string,
  ): Promise<T> {
    const inicio = Date.now();
    let status: number;
    let data: T;
    try {
      // `params` (e não a URL montada à mão) garante o encode dos valores.
      ({ status, data } = await axios.get<T>(`${this.baseUrl}${caminho}`, {
        params,
        timeout: CLUBGAS_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${token}` },
      }));
    } catch (falha) {
      throw clubgasErroDeFalha(operacao, falha, Date.now() - inicio);
    }

    const erro = clubgasErroDeCorpo(
      operacao,
      status,
      data,
      Date.now() - inicio,
    );
    if (erro) throw erro;
    return data;
  }

  async obterPostosMapa(
    baseOrigin: BaseOrigin,
    params: { latitude: number; longitude: number; placa: string },
  ): Promise<ClubgasPostosResponse> {
    const token = this.resolverToken(baseOrigin, 'POSTOS');
    return this.get<ClubgasPostosResponse>(
      'POSTOS',
      '/Posto/obter-map-app',
      {
        Latitude: params.latitude,
        Longitude: params.longitude,
        Placa: params.placa,
      },
      token,
    );
  }

  async obterCartaoVirtual(
    baseOrigin: BaseOrigin,
    params: { placa: string; cpf: string },
  ): Promise<unknown> {
    const token = this.resolverToken(baseOrigin, 'CARTAO_VIRTUAL');
    return this.get(
      'CARTAO_VIRTUAL',
      '/CartaoClub/obter-virtual',
      { Placa: params.placa, Cpf: params.cpf },
      token,
    );
  }

  /**
   * Consulta o total economizado usando o token global TOKEN_API_CLUBGAS.
   *
   * ATENÇÃO: mantém o comportamento legado (token fixo, ignora multi-tenant)
   * de forma intencional — a migração para token por base é uma mudança de
   * comportamento pendente de decisão (ver Apêndice A do plano de refatoração).
   */
  async obterTotalEconomizadoLegado(cpfCnpj: string): Promise<any> {
    return this.get(
      'TOTAL_ECONOMIZADO',
      '/Aplicativo/total-economizado',
      { CpfCnpj: cpfCnpj },
      process.env.TOKEN_API_CLUBGAS as string,
    );
  }
}

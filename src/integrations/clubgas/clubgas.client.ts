import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TokenResolverService } from '../../shared/token-resolver.service';
import { BaseOrigin } from '../../config/tenant.config';
import {
  ClubgasConfig,
  carregarClubgasConfig,
} from 'src/integrations/clubgas/clubgas.config';

export interface ClubgasPostosResponse {
  result: unknown[];
}

/**
 * Client HTTP da API ClubGas. Único ponto da aplicação que conhece a URL
 * e resolve o token da integração por base (multi-tenant).
 *
 * Em modo de teste (CLUBGAS_TEST_PLACA/CLUBGAS_TEST_CPF definidas), placa e
 * CPF do usuário são substituídos pelos fixos exigidos pela homologação da
 * ClubGas. Ver clubgas.config.ts.
 */
@Injectable()
export class ClubgasClient {
  private readonly logger = new Logger(ClubgasClient.name);
  private readonly config: ClubgasConfig = carregarClubgasConfig();
  private readonly baseUrl = this.config.baseUrl;

  constructor(private readonly tokenResolver: TokenResolverService) {}

  private placaEfetiva(placa: string): string {
    return this.config.testPlaca ?? placa;
  }

  private cpfEfetivo(cpf: string): string {
    return this.config.testCpf ?? cpf;
  }

  private resolverToken(baseOrigin: BaseOrigin, contexto: string): string {
    const token = this.tokenResolver.resolveClubgasToken(baseOrigin);
    return token;
  }

  private async get<T>(url: string, token: string): Promise<T> {
    const { data } = await axios.get<T>(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return data;
  }

  async obterPostosMapa(
    baseOrigin: BaseOrigin,
    params: { latitude: number; longitude: number; placa: string },
  ): Promise<ClubgasPostosResponse> {
    const token = this.resolverToken(baseOrigin, 'postos');
    const url = `${this.baseUrl}/Posto/obter-map-app?Latitude=${params.latitude}&Longitude=${params.longitude}&Placa=${this.placaEfetiva(params.placa)}`;
    return this.get<ClubgasPostosResponse>(url, token);
  }

  async obterCartaoVirtual(
    baseOrigin: BaseOrigin,
    params: { placa: string; cpf: string },
  ): Promise<unknown> {
    const token = this.resolverToken(baseOrigin, 'cartão');
    const url = `${this.baseUrl}/CartaoClub/obter-virtual?Placa=${this.placaEfetiva(params.placa)}&Cpf=${this.cpfEfetivo(params.cpf)}`;
    return this.get(url, token);
  }

  /**
   * Consulta o total economizado usando o token global TOKEN_API_CLUBGAS.
   *
   * ATENÇÃO: mantém o comportamento legado (token fixo, ignora multi-tenant)
   * de forma intencional — a migração para token por base é uma mudança de
   * comportamento pendente de decisão (ver Apêndice A do plano de refatoração).
   */
  async obterTotalEconomizadoLegado(cpfCnpj: string): Promise<any> {
    const url = `${this.baseUrl}/Aplicativo/total-economizado?CpfCnpj=${this.cpfEfetivo(cpfCnpj)}`;
    return this.get(url, process.env.TOKEN_API_CLUBGAS as string);
  }
}

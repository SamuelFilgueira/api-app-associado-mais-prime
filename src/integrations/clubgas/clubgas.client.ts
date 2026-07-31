import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TokenResolverService } from '../../shared/token-resolver.service';
import { BaseOrigin } from '../../config/tenant.config';
import { baseTag, maskSecret } from '../../shared/log.util';

export interface ClubgasPostosResponse {
  result: unknown[];
}

/**
 * Client HTTP da API ClubGas. Único ponto da aplicação que conhece a URL
 * e resolve o token da integração por base (multi-tenant).
 */
@Injectable()
export class ClubgasClient {
  private readonly logger = new Logger(ClubgasClient.name);
  private readonly baseUrl =
    process.env.CLUBGAS_BASE_URL ??
    'https://clubgas-api.azurewebsites.net/api/v1';

  constructor(private readonly tokenResolver: TokenResolverService) {}

  private resolverToken(baseOrigin: BaseOrigin, contexto: string): string {
    const tokenKey = this.tokenResolver.getTokenKey(baseOrigin, 'clubgas');
    const token = this.tokenResolver.resolveClubgasToken(baseOrigin);
    this.logger.log(
      `${baseTag(baseOrigin)} ClubGas ${contexto} usando tokenKey=${tokenKey} token=${maskSecret(token)}`,
    );
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
    const url = `${this.baseUrl}/Posto/obter-map-app?Latitude=${params.latitude}&Longitude=${params.longitude}&Placa=${params.placa}`;
    this.logger.log(`URL chamada para API de postos: ${url}`);
    return this.get<ClubgasPostosResponse>(url, token);
  }

  async obterCartaoVirtual(
    baseOrigin: BaseOrigin,
    params: { placa: string; cpf: string },
  ): Promise<unknown> {
    const token = this.resolverToken(baseOrigin, 'cartão');
    const url = `${this.baseUrl}/CartaoClub/obter-virtual?Placa=${params.placa}&Cpf=${params.cpf}`;
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
    const url = `${this.baseUrl}/Aplicativo/total-economizado?CpfCnpj=${cpfCnpj}`;
    return this.get(url, process.env.TOKEN_API_CLUBGAS as string);
  }
}

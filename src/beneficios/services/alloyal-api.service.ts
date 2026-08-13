import {
  AlloyalCouponRedeemRequestDto,
  AlloyalCouponRedeemResponseDto,
  AlloyalCouponOrderResponseDto,
} from 'src/beneficios/dto/alloyal-coupon-redeem.dto';
import { AlloyalCouponGenericRedeemRequestDto } from 'src/beneficios/dto/alloyal-coupon-generic-redeem-request.dto';
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { AlloyalOrganizationCouponDto } from 'src/beneficios/dto/alloyal-organization-coupon.dto';
import { AlloyalBranchCouponDto } from 'src/beneficios/dto/alloyal-branch-coupon.dto';
import { AlloyalCouponDetailDto } from 'src/beneficios/dto/alloyal-coupon-detail.dto';
import { AlloyalOrganizationHighlightOnlineDto } from 'src/beneficios/dto/alloyal-organization-highlight-online.dto';
import { AlloyalBranchDto } from 'src/beneficios/dto/alloyal-branch.dto';
import { AlloyalOrganizationCategoryDto } from 'src/beneficios/dto/alloyal-organization.dto';
import { AlloyalOrganizationListDto } from 'src/beneficios/dto/alloyal-organization-list.dto';
import { AlloyalOrganizationNearestDto } from 'src/beneficios/dto/alloyal-organization-nearest.dto';
import { AlloyalOrganizationHighlightDto } from 'src/beneficios/dto/alloyal-organization-highlight.dto';
import { AlloyalPromotionDto } from 'src/beneficios/dto/alloyal-promotion.dto';
import { AlloyalCashbackRecordsResponseDto } from 'src/beneficios/dto/alloyal-cashback.dto';
import { AlloyalCashbackTransferRequestDto } from 'src/beneficios/dto/alloyal-cashback-transfer-request.dto';
import { AlloyalUserDto } from 'src/beneficios/dto/alloyal-user.dto';
import { AlloyalCreateUserRequestDto } from 'src/beneficios/dto/alloyal-create-user.dto';
import { AlloyalUpdateUserRequestDto } from 'src/beneficios/dto/alloyal-update-user.dto';
import { BaseContextService } from 'src/shared/base-context.service';
import { baseTag, maskSecret } from 'src/shared/log.util';
import {
  BaseOrigin,
  TokenResolverService,
} from 'src/shared/token-resolver.service';

/**
 * Interface para armazenar os headers de autenticação da API Alloyal
 */
interface AuthHeaders {
  uid: string;
  client: string;
  'access-token': string;
  'api-secret': string;
}

/**
 * Headers de sessão da Alloyal que o cliente deve enviar para este backend.
 * O api-secret permanece apenas no servidor.
 */
export interface AlloyalSessionHeaders {
  uid: string;
  client: string;
  accessToken: string;
}

interface AlloyalCredentialContext {
  baseOrigin: BaseOrigin;
  apiSecret: string;
  businessId: string;
  businessCnpj: string;
  apiSecretEnv: string;
  businessIdEnv: string;
  businessCnpjEnv: string;
}

/**
 * Service responsável por gerenciar todas as interações com a API Alloyal
 * Implementa autenticação automática e cache de tokens
 */
@Injectable()
export class AlloyalApiService {
  private readonly logger = new Logger(AlloyalApiService.name);
  private axiosInstance: AxiosInstance;

  constructor(
    private readonly baseContextService: BaseContextService,
    private readonly tokenResolverService: TokenResolverService,
  ) {
    // Remove barra final da baseURL para evitar "//" ao concatenar os paths
    this.axiosInstance = axios.create({
      baseURL: process.env.BASE_URL_ALLOYAL?.replace(/\/+$/, ''),
    });

    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        this.logAxiosError('axiosInstance', error);
        return Promise.reject(error);
      },
    );
  }

  /**
   * Serializa qualquer valor para log, truncando payloads grandes
   */
  private safeStringify(value: unknown, maxLength = 3000): string {
    if (value === undefined || value === null) return '(vazio)';
    try {
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      return str.length > maxLength
        ? `${str.slice(0, maxLength)}... (truncado, ${str.length} chars)`
        : str;
    } catch {
      return '(não serializável)';
    }
  }

  /**
   * Mascara headers sensíveis antes de logar (nunca logar tokens em claro)
   */
  private maskHeaders(headers: any): Record<string, string> {
    if (!headers) return {};
    const sensitiveKeys = [
      'api-secret',
      'access-token',
      'authorization',
      'x-clientemployee-token',
    ];
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') continue;
      result[key] = sensitiveKeys.includes(key.toLowerCase())
        ? maskSecret(String(value))
        : String(value);
    }
    return result;
  }

  /**
   * Mascara campos sensíveis do body (password) antes de logar
   */
  private maskSensitiveFields(data: any): any {
    if (!data || typeof data !== 'object') return data;
    const clone = { ...data };
    if (clone.password) clone.password = maskSecret(String(clone.password));
    return clone;
  }

  /**
   * Loga detalhes completos de um erro Axios: método, URL, params, body,
   * status e corpo da resposta de erro
   */
  private logAxiosError(operation: string, error: any): void {
    const config = error?.config ?? {};
    const fullUrl = `${config.baseURL ?? ''}${config.url ?? ''}`;
    this.logger.error(
      `[Alloyal ERRO] operação=${operation}` +
        ` | ${String(config.method ?? '?').toUpperCase()} ${fullUrl}` +
        ` | request params: ${this.safeStringify(config.params)}` +
        ` | request body: ${this.safeStringify(this.maskSensitiveFields(this.parseIfJson(config.data)))}` +
        ` | request headers: ${this.safeStringify(this.maskHeaders(config.headers))}` +
        ` | response status: ${error?.response?.status ?? '(sem resposta)'}` +
        ` | response data: ${this.safeStringify(error?.response?.data)}` +
        ` | response headers: ${this.safeStringify(this.maskHeaders(error?.response?.headers))}`,
    );
  }

  /**
   * Axios serializa o body como string JSON no config; desfaz para mascarar campos
   */
  private parseIfJson(data: any): any {
    if (typeof data !== 'string') return data;
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  private resolveAlloyalCredentials(
    operation: string,
  ): AlloyalCredentialContext {
    const baseOrigin = this.baseContextService.getBaseOrigin();
    const apiSecretEnv = this.tokenResolverService.getTokenKey(
      baseOrigin,
      'apiSecretAlloyal',
    );
    const businessIdEnv = this.tokenResolverService.getTokenKey(
      baseOrigin,
      'alloyalBusinessId',
    );
    const businessCnpjEnv = this.tokenResolverService.getTokenKey(
      baseOrigin,
      'alloyalBusinessCnpj',
    );
    const credentials = {
      baseOrigin,
      apiSecret: this.baseContextService.getApiSecretAlloyal(),
      businessId: this.baseContextService.getAlloyalBusinessId(),
      businessCnpj: this.baseContextService.getAlloyalBusinessCnpj(),
      apiSecretEnv,
      businessIdEnv,
      businessCnpjEnv,
    };

    return credentials;
  }

  private getAlloyalBaseUrlOrigin(baseOrigin: BaseOrigin): string {
    const origin = new URL(
      process.env.BASE_URL_ALLOYAL || 'https://api.lecupon.com',
    ).origin;

    return origin;
  }

  private buildAuthHeaders(session: AlloyalSessionHeaders): AuthHeaders {
    if (!session?.uid || !session?.client || !session?.accessToken) {
      throw new Error('Missing Alloyal session headers');
    }

    const { apiSecret } = this.resolveAlloyalCredentials(
      'authenticated request',
    );
    return {
      uid: session.uid,
      client: session.client,
      'access-token': session.accessToken,
      'api-secret': apiSecret,
    };
  }

  /**
   * Executa uma requisição HTTP com retry automático em caso de erro 401
   * A função recebe os headers atualizados como parâmetro para evitar closure com headers antigos
   * @param requestFn Função que recebe headers atualizados e executa a requisição
   * @param maxRetries Número máximo de tentativas (padrão: 1)
   * @returns Resposta da requisição
   */
  private async makeAuthenticatedRequest<T>(
    requestFn: (headers: AuthHeaders) => Promise<AxiosResponse<T>>,
    session: AlloyalSessionHeaders,
  ): Promise<AxiosResponse<T>> {
    const headers = this.buildAuthHeaders(session);
    return await requestFn(headers);
  }

  /**
   * Realiza autenticação na API Alloyal e armazena os tokens em cache
   * @throws Error se a autenticação falhar ou headers estiverem ausentes
   */
  async login(cpf: string, password: string): Promise<AlloyalSessionHeaders> {
    try {
      const { apiSecret, baseOrigin } = this.resolveAlloyalCredentials('login');
      const body = {
        cpf,
        password,
      };

      const response: AxiosResponse = await this.axiosInstance.post(
        '/auth/sign_in',
        body,
        {
          headers: {
            'api-secret': apiSecret,
          },
        },
      );

      const headers = response.headers;
      const uid = headers['uid'];
      const client = headers['client'];
      const accessToken = headers['access-token'];

      if (!uid || !client || !accessToken) {
        this.logger.error(
          `${baseTag(baseOrigin)} [login] Headers de autenticação ausentes na resposta` +
            ` | headers recebidos: ${this.safeStringify(Object.keys(headers ?? {}))}` +
            ` | body da resposta: ${this.safeStringify(response.data)}`,
        );
        throw new Error('Missing authentication headers in response');
      }

      return {
        uid,
        client,
        accessToken: accessToken,
      };
    } catch (error) {
      this.logger.error('Erro ao fazer login na API Alloyal', error.stack);
      throw error;
    }
  }

  /**
   * Busca todas as categorias disponíveis na API Alloyal
   * @returns Lista de categorias
   */
  async getCategories(session: AlloyalSessionHeaders): Promise<any[]> {
    try {
      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get('/categories', {
            headers: { ...headers },
          }),
        session,
      );
      return response.data;
    } catch (error) {
      this.logger.error('Erro ao buscar categorias', error.stack);
      throw error;
    }
  }

  /**
   * Busca organizações de uma categoria específica
   * @param id ID da categoria
   * @param page Número da página para paginação
   * @param lat Latitude para cálculo de distância (opcional)
   * @param lng Longitude para cálculo de distância (opcional)
   * @returns Lista de organizações da categoria
   */
  async getOrganizationsByCategory(
    id: string,
    page = 1,
    lat?: string,
    lng?: string,
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalOrganizationCategoryDto[]> {
    try {
      const params: any = { page };
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get(`/categories/${id}/organizations`, {
            headers: { ...headers },
            params,
          }),
        session,
      );
      // Remove campos desnecessários e formata distância
      return response.data.map((org: any) => {
        const {
          instagram_url: _instagram_url,
          facebook_url: _facebook_url,
          twitter_url: _twitter_url,
          top_background_image_large: _top_background_image_large,
          top_background_image_v2_large: _top_background_image_v2_large,
          banner_image_large: _banner_image_large,
          banner_image_v2_large: _banner_image_v2_large,
          ...rest
        } = org;
        return {
          ...rest,
          distance_km: rest.distance_km
            ? Math.round(rest.distance_km * 100) / 100
            : 0,
        };
      });
    } catch (error) {
      this.logger.error(
        `Erro ao buscar organizações da categoria ${id}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Busca todas as organizações com filtros opcionais
   * @param page Número da página para paginação
   * @param lat Latitude para cálculo de distância (opcional)
   * @param lng Longitude para cálculo de distância (opcional)
   * @param organization_type Tipo de organização (online/física) (opcional)
   * @param search Termo de busca (opcional)
   * @param category_id ID da categoria para filtrar (opcional)
   * @returns Lista de organizações
   */
  async getOrganizations(
    page = 1,
    lat?: string,
    lng?: string,
    organization_type?: string,
    search?: string,
    category_id?: number,
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalOrganizationListDto[]> {
    try {
      // Monta parâmetros da requisição
      const params: any = { page };
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;
      if (organization_type) params.organization_type = organization_type;
      if (search) params.search = search;
      if (category_id) params.category_id = category_id;

      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get('/organizations', {
            headers: { ...headers },
            params,
          }),
        session,
      );

      // Mapeia dados e formata distância
      return response.data.map((org: any) => this.mapOrganization(org));
    } catch (error) {
      this.logger.error('Erro ao buscar organizações', error.stack);
      throw error;
    }
  }

  /**
   * Busca organizações físicas mais próximas baseado em coordenadas
   * @param lat Latitude de referência (opcional)
   * @param lng Longitude de referência (opcional)
   * @returns Lista de organizações próximas ordenadas por distância
   */
  async getNearestOrganizations(
    lat?: string,
    lng?: string,
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalOrganizationNearestDto[]> {
    try {
      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get('/organizations/nearest', {
            headers: { ...headers },
            params,
          }),
        session,
      );

      return response.data.map((org: any) => this.mapOrganization(org));
    } catch (error) {
      this.logger.error(
        'Erro ao buscar organizações mais próximas',
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Lista promoções disponíveis
   * @param page Página para paginação (opcional)
   * @param lat Latitude (opcional)
   * @param lng Longitude (opcional)
   * @param redeem_type Tipo do resgate: "physical" ou "online" (opcional)
   * @param category_id ID da categoria (opcional)
   * @param organization_id ID da marca (opcional)
   * @param distance_km Distância máxima em km (opcional, padrão 30, máximo 30)
   * @param term Termo de busca (opcional)
   * @returns Lista de promoções
   */
  async getPromotions(
    page?: number,
    lat?: string,
    lng?: string,
    redeem_type?: string,
    category_id?: number,
    organization_id?: number,
    distance_km?: number,
    term?: string,
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalPromotionDto[]> {
    try {
      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;
      if (page) params.page = page;
      if (redeem_type) params.redeem_type = redeem_type;
      if (category_id) params.category_id = category_id;
      if (organization_id) params.organization_id = organization_id;
      if (distance_km) params.distance_km = Math.min(distance_km, 30);
      if (term) params.term = term;

      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get('/promotions', {
            headers: { ...headers },
            params,
          }),
        session,
      );

      return response.data.map((promo: any) => ({
        id: promo.id,
        title: promo.title,
        rules: promo.rules,
        description: promo.description,
        url: promo.url,
        discount: promo.discount,
        start_date: promo.start_date
          ? new Date(promo.start_date).toLocaleString('pt-BR')
          : '',
        end_date: promo.end_date
          ? new Date(promo.end_date).toLocaleString('pt-BR')
          : '',
        working_days: Array.isArray(promo.working_days)
          ? promo.working_days.map((wd: any) => ({
              week_day: wd.week_day,
              is_available: wd.is_available,
              start_hour: wd.start_hour,
              end_hour: wd.end_hour,
            }))
          : [],
        quantity: promo.quantity,
        redeemed_count: promo.redeemed_count,
        infinity: promo.infinity,
        organization_id: promo.organization_id,
        dynamic_voucher: promo.dynamic_voucher,
        branch_id: promo.branch_id,
        coupon_id: promo.coupon_id,
        tags: Array.isArray(promo.tags) ? promo.tags : [],
      }));
    } catch (error) {
      this.logger.error('Erro ao buscar promoções', error.stack);
      throw error;
    }
  }

  /**
   * Lista transações de cashback do usuário (saldo e utilização)
   * GET /cashback_records
   * @returns Resumo de cashback e lista de transações
   */
  async getCashbackRecords(
    session: AlloyalSessionHeaders,
  ): Promise<AlloyalCashbackRecordsResponseDto> {
    try {
      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get('/cashback_records', {
            headers: { ...headers },
          }),
        session,
      );

      const data = response.data;

      return {
        total_amount: Number(data?.total_amount ?? 0),
        pending_amount: Number(data?.pending_amount ?? 0),
        approved_amount: Number(data?.approved_amount ?? 0),
        available_amount: Number(data?.available_amount ?? 0),
        in_transfer_amount: Number(data?.in_transfer_amount ?? 0),
        transferred_amount: Number(data?.transferred_amount ?? 0),
        title: data?.title ?? '',
        subtitle: data?.subtitle ?? '',
        status: data?.status ?? '',
        cashback_records: Array.isArray(data?.cashback_records)
          ? data.cashback_records
          : [],
      };
    } catch (error) {
      this.logger.error('Erro ao buscar transações de cashback', error.stack);
      throw error;
    }
  }

  /**
   * Solicita resgate de cashback para chave PIX vinculada ao CPF
   * POST /cashback_transfer_requests
   * @param dto CPF do usuário solicitante
   */
  async requestCashbackTransfer(
    dto: AlloyalCashbackTransferRequestDto,
    session: AlloyalSessionHeaders,
  ): Promise<void> {
    try {
      await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.post('/cashback_transfer_requests', dto, {
            headers: { ...headers },
          }),
        session,
      );
    } catch (error) {
      this.logger.error('Erro ao solicitar resgate de cashback', error.stack);
      throw error;
    }
  }

  /**
   * Busca usuários associados por CPF utilizando credenciais de employee
   * GET /client/v3/businesses/{businessId}/users
   * @param cpf CPF do usuário (apenas números, sem caracteres especiais)
   * @returns Lista de usuários encontrados ou array vazio
   */
  async searchUserByCpf(cpf: string): Promise<AlloyalUserDto[]> {
    try {
      const clientEmployeeEmail = process.env.x_clientemployee_email;
      const clientEmployeeToken = process.env.x_clientemployee_token;
      const { baseOrigin, businessCnpj } =
        this.resolveAlloyalCredentials('searchUserByCpf');

      if (!clientEmployeeEmail || !clientEmployeeToken) {
        this.logger.error(
          'x_clientemployee_email ou x_clientemployee_token não configurados',
        );
        throw new Error(
          'Missing x_clientemployee_email or x_clientemployee_token',
        );
      }

      // Remove caracteres especiais do CPF (apenas números)
      const cleanCpf = cpf.replace(/\D/g, '');

      const apiBaseOrigin = this.getAlloyalBaseUrlOrigin(baseOrigin);
      const url = `${apiBaseOrigin}/client/v2/businesses/${businessCnpj}/users`;
      const params = {
        page: 1,
        active: true,
        term: cleanCpf,
      };

      const response = await axios.get(url, {
        headers: {
          'x-clientemployee-email': clientEmployeeEmail,
          'x-clientemployee-token': clientEmployeeToken,
        },
        params,
      });

      // Retorna array de usuários ou array vazio
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      this.logAxiosError('searchUserByCpf', error);
      this.logger.error('Erro ao buscar usuário por CPF', error.stack);
      throw error;
    }
  }

  /**
   * Busca organizações em destaque próximas baseado em coordenadas
   * @param lat Latitude de referência (opcional)
   * @param lng Longitude de referência (opcional)
   * @returns Lista de organizações em destaque próximas
   */
  async getHighlightsNearby(
    lat?: string,
    lng?: string,
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalOrganizationHighlightDto[]> {
    try {
      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get('/organizations/highlights_nearby', {
            headers: { ...headers },
            params,
          }),
        session,
      );

      return response.data.map((org: any) => this.mapOrganization(org));
    } catch (error) {
      this.logger.error(
        'Erro ao buscar organizações em destaque próximas',
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Busca todas as filiais físicas de uma organização
   * @param organization_id ID da organização
   * @param lat Latitude para cálculo de distância (opcional)
   * @param lng Longitude para cálculo de distância (opcional)
   * @returns Lista de filiais da organização
   */
  async getBranchesByOrganization(
    organization_id: number,
    lat?: string,
    lng?: string,
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalBranchDto[]> {
    try {
      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get(`/organizations/${organization_id}/branches`, {
            headers: { ...headers },
            params,
          }),
        session,
      );

      // Formata horários e distância
      return response.data.map((branch: any) => ({
        id: branch.id,
        name: branch.name,
        taxpayer_number: branch.taxpayer_number,
        telephone: branch.telephone,
        full_address: branch.full_address,
        zipcode: branch.zipcode,
        lat: branch.lat,
        lng: branch.lng,
        opening_time: branch.opening_time
          ? new Date(branch.opening_time).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : '',
        closing_time: branch.closing_time
          ? new Date(branch.closing_time).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : '',
        distance_km: branch.distance_km
          ? Math.round(branch.distance_km * 100) / 100
          : 0,
      }));
    } catch (error) {
      this.logger.error(
        `Erro ao buscar filiais da organização ${organization_id}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Busca organizações online em destaque
   * @returns Lista de organizações online em destaque
   */
  async getHighlightsOnline(
    session: AlloyalSessionHeaders,
  ): Promise<AlloyalOrganizationHighlightOnlineDto[]> {
    try {
      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get('/organizations/highlights_online', {
            headers: { ...headers },
          }),
        session,
      );

      return response.data.map((org: any) => this.mapOrganization(org, false));
    } catch (error) {
      this.logger.error(
        'Erro ao buscar organizações online em destaque',
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Busca cupons de uma organização específica
   * @param organization_id ID da organização
   * @param usage_type Tipo de uso do cupom (online/presencial) - padrão: 'online'
   * @returns Lista de cupons da organização
   */
  async getOrganizationCoupons(
    organization_id: number,
    usage_type: string = 'online',
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalOrganizationCouponDto[]> {
    try {
      const params: any = { usage_type };
      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get(`/organizations/${organization_id}/coupons`, {
            headers: { ...headers },
            params,
          }),
        session,
      );

      // Formata datas para padrão brasileiro
      return response.data.map((coupon: any) => ({
        id: coupon.id,
        template: coupon.template,
        title: coupon.title,
        description: coupon.description,
        cashback_text: coupon.cashback_text,
        online_payment_text: coupon.online_payment_text,
        discount: coupon.discount,
        start_date: coupon.start_date
          ? new Date(coupon.start_date).toLocaleDateString('pt-BR')
          : '',
        end_date: coupon.end_date
          ? new Date(coupon.end_date).toLocaleDateString('pt-BR')
          : '',
      }));
    } catch (error) {
      this.logger.error(
        `Erro ao buscar cupons da organização ${organization_id}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Busca cupons de uma filial específica
   * @param organization_id ID da organização
   * @param branch_id ID da filial
   * @param page Número da página para paginação
   * @returns Lista de cupons da filial
   */
  async getBranchCoupons(
    organization_id: number,
    branch_id: number,
    page: number = 1,
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalBranchCouponDto[]> {
    try {
      const params: any = { page };
      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get(
            `/organizations/${organization_id}/branches/${branch_id}/coupons`,
            {
              headers: { ...headers },
              params,
            },
          ),
        session,
      );

      // Formata datas para padrão brasileiro
      return response.data.map((coupon: any) => ({
        id: coupon.id,
        template: coupon.template,
        title: coupon.title,
        description: coupon.description,
        cashback_text: coupon.cashback_text,
        online_payment_text: coupon.online_payment_text,
        discount: coupon.discount,
        start_date: coupon.start_date
          ? new Date(coupon.start_date).toLocaleDateString('pt-BR')
          : '',
        end_date: coupon.end_date
          ? new Date(coupon.end_date).toLocaleDateString('pt-BR')
          : '',
        infinity: coupon.infinity,
        picture_small_url: coupon.picture_small_url,
        picture_large_url: coupon.picture_large_url,
        organization_id: coupon.organization_id,
        branch_id: coupon.branch_id,
      }));
    } catch (error) {
      this.logger.error(
        `Erro ao buscar cupons da filial ${branch_id} da organização ${organization_id}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Busca detalhes completos de um cupom específico
   * @param organization_id ID da organização
   * @param coupon_id ID do cupom
   * @returns Detalhes completos do cupom
   */
  async getCouponDetail(
    organization_id: number,
    coupon_id: number,
    session?: AlloyalSessionHeaders,
  ): Promise<AlloyalCouponDetailDto> {
    try {
      if (!session) throw new Error('Missing Alloyal session headers');

      const response = await this.makeAuthenticatedRequest(
        (headers) =>
          this.axiosInstance.get(
            `/organizations/${organization_id}/coupons/${coupon_id}`,
            {
              headers: { ...headers },
            },
          ),
        session,
      );

      const c = response.data;

      // Mapeia e formata dados do cupom
      return {
        id: c.id,
        organization_name: c.organization_name,
        organization_cover_image: c.organization_cover_image,
        template: c.template,
        title: c.title,
        description: c.description,
        activation_url: c.activation_url,
        rules: c.rules,
        cashback_text: c.cashback_text,
        discount: c.discount,
        start_date: c.start_date
          ? new Date(c.start_date).toLocaleDateString('pt-BR')
          : '',
        end_date: c.end_date
          ? new Date(c.end_date).toLocaleDateString('pt-BR')
          : '',
        code: c.code,
        picture_small_url: c.picture_small_url,
        picture_large_url: c.picture_large_url,
        working_days: c.working_days,
      };
    } catch (error) {
      this.logger.error(
        `Erro ao buscar detalhes do cupom ${coupon_id} da organização ${organization_id}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Resgatar cupom com código (coupon_code)
   * GET /organizations/{organization_id}/orders
   */
  async redeemCouponWithCode(
    organization_id: number,
    dto: AlloyalCouponRedeemRequestDto,
    session: AlloyalSessionHeaders,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    const response = await this.makeAuthenticatedRequest(
      (headers) =>
        this.axiosInstance.get(`/organizations/${organization_id}/orders`, {
          headers: { ...headers },
          params: dto,
        }),
      session,
    );
    return response.data;
  }

  /**
   * Listar todos os resgates de cupom
   * GET /orders
   */
  async listAllCouponOrders(
    session: AlloyalSessionHeaders,
  ): Promise<AlloyalCouponOrderResponseDto[]> {
    const response = await this.makeAuthenticatedRequest(
      (headers) =>
        this.axiosInstance.get('/orders', {
          headers: { ...headers },
        }),
      session,
    );
    return response.data;
  }

  /**
   * Resgatar cupom genérico
   * POST /orders
   */
  async redeemCouponGeneric(
    dto: AlloyalCouponGenericRedeemRequestDto,
    session: AlloyalSessionHeaders,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    const response = await this.makeAuthenticatedRequest(
      (headers) =>
        this.axiosInstance.post('/orders', dto, {
          headers: { ...headers },
        }),
      session,
    );
    return response.data;
  }

  /**
   * Cria um novo usuário na plataforma Alloyal
   * POST /client/v2/businesses/{cnpj}/users
   * @param dto Dados do usuário a ser criado
   * @returns Dados do usuário criado
   */
  async createUser(dto: AlloyalCreateUserRequestDto): Promise<AlloyalUserDto> {
    try {
      const clientEmployeeEmail = process.env.x_clientemployee_email;
      const clientEmployeeToken = process.env.x_clientemployee_token;
      const { baseOrigin, businessCnpj } =
        this.resolveAlloyalCredentials('createUser');

      if (!clientEmployeeEmail || !clientEmployeeToken) {
        this.logger.error(
          'x_clientemployee_email ou x_clientemployee_token não configurados',
        );
        throw new Error(
          'Missing x_clientemployee_email or x_clientemployee_token',
        );
      }

      const apiBaseOrigin = this.getAlloyalBaseUrlOrigin(baseOrigin);

      const body = {
        name: dto.name,
        cpf: dto.cpf,
        email: dto.email,
        password: dto.password,
        user_tags: 'APP-ASSOCIADO',
      };

      const url = `${apiBaseOrigin}/client/v2/businesses/${businessCnpj}/users`;

      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'Tentant-id': businessCnpj,
          'X-ClientEmployee-Email': clientEmployeeEmail,
          'X-ClientEmployee-Token': clientEmployeeToken,
        },
      });

      const user: AlloyalUserDto = response.data;

      // A Alloyal faz upsert: se o CPF já existia no business, o POST retorna o
      // registro antigo sem sobrescrever os dados. Se esse registro estiver
      // desativado, o login retornaria 403 — reativa e redefine a senha.
      if (user && user.active === false) {
        this.logger.warn(
          `${baseTag(baseOrigin)} [createUser] Usuário já existia na Alloyal e está desativado (id=${user.id}, activated_at=${user.activated_at}, default_auth_flow=${user.default_auth_flow}) — reativando com os novos dados`,
        );
        return await this.updateUser(dto.cpf, {
          name: dto.name,
          email: dto.email,
          password: dto.password,
          active: true,
          user_tags: ['APP-ASSOCIADO'],
        });
      }

      return user;
    } catch (error) {
      this.logAxiosError('createUser', error);
      this.logger.error(
        `Erro ao criar usuário na API Alloyal - status: ${error?.response?.status} - data: ${JSON.stringify(error?.response?.data)}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Atualiza dados de um usuário na plataforma Alloyal
   * PATCH /client/v2/businesses/{cnpj}/users/{cpf}
   * Referência: https://lecupon.readme.io/reference/editar-usuário
   * @param cpf CPF do usuário (identificador no path, apenas números)
   * @param dto Campos a serem atualizados (todos opcionais, inclui active e user_tags)
   * @returns Dados atualizados do usuário
   */
  async updateUser(
    cpf: string,
    dto: AlloyalUpdateUserRequestDto,
  ): Promise<AlloyalUserDto> {
    try {
      const clientEmployeeEmail = process.env.x_clientemployee_email;
      const clientEmployeeToken = process.env.x_clientemployee_token;
      const { baseOrigin, businessCnpj } =
        this.resolveAlloyalCredentials('updateUser');

      if (!clientEmployeeEmail || !clientEmployeeToken) {
        this.logger.error(
          'x_clientemployee_email ou x_clientemployee_token não configurados',
        );
        throw new Error(
          'Missing x_clientemployee_email or x_clientemployee_token',
        );
      }

      const apiBaseOrigin = this.getAlloyalBaseUrlOrigin(baseOrigin);
      const cleanCpf = cpf.replace(/\D/g, '');
      const url = `${apiBaseOrigin}/client/v2/businesses/${businessCnpj}/users/${cleanCpf}`;

      const response = await axios.patch(url, dto, {
        headers: {
          'Tentant-id': businessCnpj,
          'X-ClientEmployee-Email': clientEmployeeEmail,
          'X-ClientEmployee-Token': clientEmployeeToken,
        },
      });

      return response.data;
    } catch (error) {
      this.logAxiosError('updateUser', error);
      this.logger.error(
        'Erro ao atualizar usuário na API Alloyal',
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Mapeia dados brutos de uma organização para o formato padronizado
   * @param org Dados brutos da organização da API
   * @param includeDistance Se deve incluir campo distance_km (padrão: true)
   */
  private mapOrganization(org: any, includeDistance = true): any {
    const mapped: any = {
      id: org.id,
      name: org.name,
      cover_picture: org.cover_picture,
      background_picture: org.background_picture,
      best_discount_percent: org.best_discount_percent,
      category_name: org.category_name,
      instagram_url: org.instagram_url,
      facebook_url: org.facebook_url,
      twitter_url: org.twitter_url,
      cashback_percent: org.cashback_percent,
      cashback_text: org.cashback_text,
      discount_text: org.discount_text,
      description: org.description,
    };

    if (includeDistance) {
      mapped.distance_km = org.distance_km
        ? Math.round(org.distance_km * 100) / 100
        : 0;
    }

    return mapped;
  }
}

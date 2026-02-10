import {
  AlloyalCouponRedeemRequestDto,
  AlloyalCouponRedeemResponseDto,
  AlloyalCouponOrderResponseDto,
} from './DTOs/alloyal-coupon-redeem.dto';
import { AlloyalCouponGenericRedeemRequestDto } from './DTOs/alloyal-coupon-generic-redeem-request.dto';
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { AlloyalOrganizationCouponDto } from './DTOs/alloyal-organization-coupon.dto';
import { AlloyalBranchCouponDto } from './DTOs/alloyal-branch-coupon.dto';
import { AlloyalCouponDetailDto } from './DTOs/alloyal-coupon-detail.dto';
import { AlloyalOrganizationHighlightOnlineDto } from './DTOs/alloyal-organization-highlight-online.dto';
import { AlloyalBranchDto } from './DTOs/alloyal-branch.dto';
import { AlloyalOrganizationCategoryDto } from './DTOs/alloyal-organization.dto';
import { AlloyalOrganizationListDto } from './DTOs/alloyal-organization-list.dto';
import { AlloyalOrganizationNearestDto } from './DTOs/alloyal-organization-nearest.dto';
import { AlloyalOrganizationHighlightDto } from './DTOs/alloyal-organization-highlight.dto';
import { AlloyalPromotionDto } from './DTOs/alloyal-promotion.dto';

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
 * Service responsável por gerenciar todas as interações com a API Alloyal
 * Implementa autenticação automática e cache de tokens
 */
@Injectable()
export class AlloyalApiService {
  private readonly logger = new Logger(AlloyalApiService.name);
  private axiosInstance: AxiosInstance;
  private authHeaders: AuthHeaders | null = null;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: process.env.BASE_URL_ALLOYAL,
    });
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
    maxRetries: number = 1,
  ): Promise<AxiosResponse<T>> {
    let attempts = 0;

    while (attempts <= maxRetries) {
      try {
        // Garante que estamos autenticados
        if (!this.authHeaders) {
          await this.login();
        }

        // Executa a requisição passando os headers atualizados
        return await requestFn(this.authHeaders!);
      } catch (error) {
        // Verifica se é um erro 401 (não autorizado)
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          attempts++;

          if (attempts <= maxRetries) {
            this.logger.warn(
              `Erro 401 detectado. Renovando autenticação e tentando novamente (tentativa ${attempts}/${maxRetries})...`,
            );

            // Limpa os headers antigos e força novo login
            this.authHeaders = null;
            await this.login();

            // Continua o loop para tentar novamente com os novos headers
            continue;
          }
        }

        // Se não é 401 ou excedeu tentativas, propaga o erro
        throw error;
      }
    }

    // Não deveria chegar aqui, mas TypeScript exige
    throw new Error('Failed to complete authenticated request');
  }

  /**
   * Realiza autenticação na API Alloyal e armazena os tokens em cache
   * @throws Error se a autenticação falhar ou headers estiverem ausentes
   */
  async login(): Promise<void> {
    try {
      const apiSecret = process.env.API_SECRET_ALLOYAL;
      if (!apiSecret) {
        this.logger.error('API_SECRET_ALLOYAL não configurado');
        throw new Error('API_SECRET_ALLOYAL not set');
      }

      const body = {
        cpf: '18534553777',
        password: 'Samuel685@',
      };

      this.logger.log('Realizando login na API Alloyal...');
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
        this.logger.error('Headers de autenticação ausentes na resposta');
        throw new Error('Missing authentication headers in response');
      }

      this.authHeaders = {
        uid,
        client,
        'access-token': accessToken,
        'api-secret': apiSecret,
      };

      this.logger.log('Login na API Alloyal realizado com sucesso');
    } catch (error) {
      this.logger.error('Erro ao fazer login na API Alloyal', error.stack);
      throw error;
    }
  }

  /**
   * Retorna os headers de autenticação atualmente em cache
   * @returns Headers de autenticação ou null se não autenticado
   */
  getAuthHeaders(): AuthHeaders | null {
    return this.authHeaders;
  }

  /**
   * Método genérico para requisições GET com autenticação automática
   * @param url URL do endpoint
   * @param config Configurações adicionais do axios
   * @returns Resposta da requisição
   */
  async get<T = any>(url: string, config: any = {}): Promise<AxiosResponse<T>> {
    if (!this.authHeaders) {
      await this.login();
    }
    return this.axiosInstance.get<T>(url, {
      ...config,
      headers: {
        ...config.headers,
        ...this.authHeaders,
      },
    });
  }

  /**
   * Busca todas as categorias disponíveis na API Alloyal
   * @returns Lista de categorias
   */
  async getCategories(): Promise<any[]> {
    try {
      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get('/categories', {
          headers: { ...headers },
        }),
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
  ): Promise<AlloyalOrganizationCategoryDto[]> {
    try {
      const params: any = { page };
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get(`/categories/${id}/organizations`, {
          headers: { ...headers },
          params,
        }),
      );
      // Remove campos desnecessários e formata distância
      return response.data.map((org: any) => {
        const {
          instagram_url,
          facebook_url,
          twitter_url,
          top_background_image_large,
          top_background_image_v2_large,
          banner_image_large,
          banner_image_v2_large,
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
  ): Promise<AlloyalOrganizationListDto[]> {
    try {
      // Monta parâmetros da requisição
      const params: any = { page };
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;
      if (organization_type) params.organization_type = organization_type;
      if (search) params.search = search;
      if (category_id) params.category_id = category_id;

      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get('/organizations', {
          headers: { ...headers },
          params,
        }),
      );

      // Mapeia dados e formata distância
      return response.data.map((org: any) => ({
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
        distance_km: org.distance_km
          ? Math.round(org.distance_km * 100) / 100
          : 0,
        cashback_text: org.cashback_text,
        discount_text: org.discount_text,
        description: org.description,
      }));
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
  ): Promise<AlloyalOrganizationNearestDto[]> {
    try {
      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get('/organizations/nearest', {
          headers: { ...headers },
          params,
        }),
      );

      return response.data.map((org: any) => ({
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
        distance_km: org.distance_km
          ? Math.round(org.distance_km * 100) / 100
          : 0,
        cashback_text: org.cashback_text,
        discount_text: org.discount_text,
        description: org.description,
      }));
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

      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get('/promotions', {
          headers: { ...headers },
          params,
        }),
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
   * Busca organizações em destaque próximas baseado em coordenadas
   * @param lat Latitude de referência (opcional)
   * @param lng Longitude de referência (opcional)
   * @returns Lista de organizações em destaque próximas
   */
  async getHighlightsNearby(
    lat?: string,
    lng?: string,
  ): Promise<AlloyalOrganizationHighlightDto[]> {
    try {
      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get('/organizations/highlights_nearby', {
          headers: { ...headers },
          params,
        }),
      );

      return response.data.map((org: any) => ({
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
        distance_km: org.distance_km
          ? Math.round(org.distance_km * 100) / 100
          : 0,
        cashback_text: org.cashback_text,
        discount_text: org.discount_text,
        description: org.description,
      }));
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
  ): Promise<AlloyalBranchDto[]> {
    try {
      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get(`/organizations/${organization_id}/branches`, {
          headers: { ...headers },
          params,
        }),
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
  async getHighlightsOnline(): Promise<
    AlloyalOrganizationHighlightOnlineDto[]
  > {
    try {
      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get('/organizations/highlights_online', {
          headers: { ...headers },
        }),
      );

      return response.data.map((org: any) => ({
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
      }));
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
  ): Promise<AlloyalOrganizationCouponDto[]> {
    try {
      const params: any = { usage_type };
      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get(`/organizations/${organization_id}/coupons`, {
          headers: { ...headers },
          params,
        }),
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
  ): Promise<AlloyalBranchCouponDto[]> {
    try {
      const params: any = { page };
      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get(
          `/organizations/${organization_id}/branches/${branch_id}/coupons`,
          {
            headers: { ...headers },
            params,
          },
        ),
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
  ): Promise<AlloyalCouponDetailDto> {
    try {
      const response = await this.makeAuthenticatedRequest((headers) =>
        this.axiosInstance.get(
          `/organizations/${organization_id}/coupons/${coupon_id}`,
          {
            headers: { ...headers },
          },
        ),
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
  ): Promise<AlloyalCouponRedeemResponseDto> {
    const response = await this.makeAuthenticatedRequest((headers) =>
      this.axiosInstance.get(`/organizations/${organization_id}/orders`, {
        headers: { ...headers },
        params: dto,
      }),
    );
    return response.data;
  }

  /**
   * Listar todos os resgates de cupom
   * GET /orders
   */
  async listAllCouponOrders(): Promise<AlloyalCouponOrderResponseDto[]> {
    const response = await this.makeAuthenticatedRequest((headers) =>
      this.axiosInstance.get('/orders', {
        headers: { ...headers },
      }),
    );
    return response.data;
  }

  /**
   * Resgatar cupom genérico
   * POST /orders
   */
  async redeemCouponGeneric(
    dto: AlloyalCouponGenericRedeemRequestDto,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    const response = await this.makeAuthenticatedRequest((headers) =>
      this.axiosInstance.post('/orders', dto, {
        headers: { ...headers },
      }),
    );
    return response.data;
  }
}

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
      if (!this.authHeaders) {
        await this.login();
      }
      const response = await this.axiosInstance.get('/categories', {
        headers: {
          ...this.authHeaders,
        },
      });
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
      if (!this.authHeaders) {
        await this.login();
      }
      const params: any = { page };
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      const response = await this.axiosInstance.get(
        `/categories/${id}/organizations`,
        {
          headers: {
            ...this.authHeaders,
          },
          params,
        },
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
      if (!this.authHeaders) {
        await this.login();
      }

      // Monta parâmetros da requisição
      const params: any = { page };
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;
      if (organization_type) params.organization_type = organization_type;
      if (search) params.search = search;
      if (category_id) params.category_id = category_id;

      const response = await this.axiosInstance.get('/organizations', {
        headers: {
          ...this.authHeaders,
        },
        params,
      });

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
      if (!this.authHeaders) {
        await this.login();
      }

      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      const response = await this.axiosInstance.get('/organizations/nearest', {
        headers: {
          ...this.authHeaders,
        },
        params,
      });

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
      if (!this.authHeaders) {
        await this.login();
      }

      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      const response = await this.axiosInstance.get(
        '/organizations/highlights_nearby',
        {
          headers: {
            ...this.authHeaders,
          },
          params,
        },
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
      if (!this.authHeaders) {
        await this.login();
      }

      const params: any = {};
      if (lat) params.lat = lat;
      if (lng) params.lng = lng;

      const response = await this.axiosInstance.get(
        `/organizations/${organization_id}/branches`,
        {
          headers: {
            ...this.authHeaders,
          },
          params,
        },
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
      if (!this.authHeaders) {
        await this.login();
      }

      const response = await this.axiosInstance.get(
        '/organizations/highlights_online',
        {
          headers: {
            ...this.authHeaders,
          },
        },
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
      if (!this.authHeaders) {
        await this.login();
      }

      const params: any = { usage_type };
      const response = await this.axiosInstance.get(
        `/organizations/${organization_id}/coupons`,
        {
          headers: {
            ...this.authHeaders,
          },
          params,
        },
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
      if (!this.authHeaders) {
        await this.login();
      }

      const params: any = { page };
      const response = await this.axiosInstance.get(
        `/organizations/${organization_id}/branches/${branch_id}/coupons`,
        {
          headers: {
            ...this.authHeaders,
          },
          params,
        },
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
      if (!this.authHeaders) {
        await this.login();
      }

      const response = await this.axiosInstance.get(
        `/organizations/${organization_id}/coupons/${coupon_id}`,
        {
          headers: {
            ...this.authHeaders,
          },
        },
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
}

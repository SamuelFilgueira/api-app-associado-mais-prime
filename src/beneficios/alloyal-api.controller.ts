import {
  Controller,
  Get,
  Param,
  Query,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AlloyalApiService } from './alloyal-api.service';
import { AlloyalCategoryDto } from './DTOs/alloyal-category.dto';
import { AlloyalOrganizationCategoryDto } from './DTOs/alloyal-organization.dto';
import { AlloyalOrganizationListDto } from './DTOs/alloyal-organization-list.dto';
import { AlloyalOrganizationNearestDto } from './DTOs/alloyal-organization-nearest.dto';
import { AlloyalOrganizationHighlightDto } from './DTOs/alloyal-organization-highlight.dto';
import { AlloyalOrganizationHighlightOnlineDto } from './DTOs/alloyal-organization-highlight-online.dto';
import { AlloyalBranchDto } from './DTOs/alloyal-branch.dto';
import { AlloyalOrganizationCouponDto } from './DTOs/alloyal-organization-coupon.dto';
import { AlloyalBranchCouponDto } from './DTOs/alloyal-branch-coupon.dto';
import { AlloyalCouponDetailDto } from './DTOs/alloyal-coupon-detail.dto';

/**
 * Controller responsável por expor endpoints da API Alloyal de benefícios
 * Gerencia categorias, organizações, filiais e cupons de desconto
 */
@Controller('alloyal')
export class AlloyalApiController {
  private readonly logger = new Logger(AlloyalApiController.name);
  constructor(private readonly alloyalApiService: AlloyalApiService) {}

  /**
   * Endpoint de teste para validar autenticação na API Alloyal
   * @returns Headers de autenticação gerados
   */
  @Get('test-login')
  async testLogin(): Promise<any> {
    try {
      await this.alloyalApiService.login();
      return this.alloyalApiService.getAuthHeaders();
    } catch (error) {
      this.logger.error('Erro no teste de login', error.stack);
      throw new HttpException(
        'Erro ao testar login na API Alloyal',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Lista todas as categorias de benefícios disponíveis
   * @returns Array de categorias
   */
  @Get('categories')
  async getCategories(): Promise<AlloyalCategoryDto[]> {
    try {
      return await this.alloyalApiService.getCategories();
    } catch (error) {
      this.logger.error('Erro ao buscar categorias', error.stack);
      throw new HttpException(
        'Erro ao buscar categorias',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Lista organizações de uma categoria específica
   * @param id ID da categoria
   * @param page Número da página (opcional)
   * @param lat Latitude para cálculo de distância (opcional)
   * @param lng Longitude para cálculo de distância (opcional)
   * @returns Array de organizações da categoria
   */
  @Get('categories/:id/organizations')
  async getOrganizationsByCategory(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ): Promise<AlloyalOrganizationCategoryDto[]> {
    try {
      return await this.alloyalApiService.getOrganizationsByCategory(
        id,
        page ? Number(page) : 1,
        lat,
        lng,
      );
    } catch (error) {
      this.logger.error(
        `Erro ao buscar organizações da categoria ${id}`,
        error.stack,
      );
      throw new HttpException(
        'Erro ao buscar organizações da categoria',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Lista todas as organizações com filtros opcionais
   * @param page Número da página (opcional)
   * @param lat Latitude para cálculo de distância (opcional)
   * @param lng Longitude para cálculo de distância (opcional)
   * @param organization_type Tipo de organização - online/física (opcional)
   * @param search Termo de busca (opcional)
   * @param category_id ID da categoria para filtrar (opcional)
   * @returns Array de organizações
   */
  @Get('organizations')
  async getOrganizations(
    @Query('page') page?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('organization_type') organization_type?: string,
    @Query('search') search?: string,
    @Query('category_id') category_id?: string,
  ): Promise<AlloyalOrganizationListDto[]> {
    try {
      return await this.alloyalApiService.getOrganizations(
        page ? Number(page) : 1,
        lat,
        lng,
        organization_type,
        search,
        category_id ? Number(category_id) : undefined,
      );
    } catch (error) {
      this.logger.error('Erro ao buscar organizações', error.stack);
      throw new HttpException(
        'Erro ao buscar organizações',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /* #region Métodos para organizações físicas e filiais */

  /**
   * Lista organizações físicas mais próximas baseado em coordenadas - É necessário utilizar o método  getBranchesByOrganization para obter as filiais próximas e informações de localização detalhadas
   * @param lat Latitude de referência (opcional)
   * @param lng Longitude de referência (opcional)
   * @returns Array de organizações próximas ordenadas por distância
   */
  @Get('organizations/nearest')
  async getNearestOrganizations(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ): Promise<AlloyalOrganizationNearestDto[]> {
    try {
      return await this.alloyalApiService.getNearestOrganizations(lat, lng);
    } catch (error) {
      this.logger.error(
        'Erro ao buscar organizações mais próximas',
        error.stack,
      );
      throw new HttpException(
        'Erro ao buscar organizações mais próximas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Lista todas as filiais físicas de uma organização
   * @param organization_id ID da organização
   * @param lat Latitude para cálculo de distância (opcional)
   * @param lng Longitude para cálculo de distância (opcional)
   * @returns Array de filiais da organização
   */
  @Get('organizations/:organization_id/branches')
  async getBranchesByOrganization(
    @Param('organization_id') organization_id: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ): Promise<AlloyalBranchDto[]> {
    try {
      return await this.alloyalApiService.getBranchesByOrganization(
        Number(organization_id),
        lat,
        lng,
      );
    } catch (error) {
      this.logger.error(
        `Erro ao buscar filiais da organização ${organization_id}`,
        error.stack,
      );
      throw new HttpException(
        'Erro ao buscar filiais da organização',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  /* #endregion */

  /* #region Métodos para organizações em destaque */

  /**
   * Lista organizações em destaque próximas baseado em coordenadas(não é necessário utilizar no momento)
   * @param lat Latitude de referência (opcional)
   * @param lng Longitude de referência (opcional)
   * @returns Array de organizações em destaque próximas
   */
  @Get('organizations/highlights_nearby')
  async getHighlightsNearby(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ): Promise<AlloyalOrganizationHighlightDto[]> {
    try {
      return await this.alloyalApiService.getHighlightsNearby(lat, lng);
    } catch (error) {
      this.logger.error(
        'Erro ao buscar organizações em destaque próximas',
        error.stack,
      );
      throw new HttpException(
        'Erro ao buscar organizações em destaque próximas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Lista organizações online em destaque
   * @returns Array de organizações online em destaque
   */
  @Get('organizations/highlights_online')
  async getHighlightsOnline(): Promise<
    AlloyalOrganizationHighlightOnlineDto[]
  > {
    try {
      return await this.alloyalApiService.getHighlightsOnline();
    } catch (error) {
      this.logger.error(
        'Erro ao buscar organizações online em destaque',
        error.stack,
      );
      throw new HttpException(
        'Erro ao buscar organizações online em destaque',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  /* #endregion */

  /* #region Métodos para cupons de desconto */

  /**
   * Lista cupons de uma organização específica
   * @param organization_id ID da organização
   * @param usage_type Tipo de uso do cupom - online/presencial (opcional)
   * @returns Array de cupons da organização
   */
  @Get('organizations/:organization_id/coupons')
  async getOrganizationCoupons(
    @Param('organization_id') organization_id: string,
    @Query('usage_type') usage_type?: string,
  ): Promise<AlloyalOrganizationCouponDto[]> {
    try {
      return await this.alloyalApiService.getOrganizationCoupons(
        Number(organization_id),
        usage_type,
      );
    } catch (error) {
      this.logger.error(
        `Erro ao buscar cupons da organização ${organization_id}`,
        error.stack,
      );
      throw new HttpException(
        'Erro ao buscar cupons da organização',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Lista cupons de uma filial específica
   * @param organization_id ID da organização
   * @param branch_id ID da filial
   * @param page Número da página (opcional)
   * @returns Array de cupons da filial
   */
  @Get('organizations/:organization_id/branches/:branch_id/coupons')
  async getBranchCoupons(
    @Param('organization_id') organization_id: string,
    @Param('branch_id') branch_id: string,
    @Query('page') page?: string,
  ): Promise<AlloyalBranchCouponDto[]> {
    try {
      return await this.alloyalApiService.getBranchCoupons(
        Number(organization_id),
        Number(branch_id),
        page ? Number(page) : 1,
      );
    } catch (error) {
      this.logger.error(
        `Erro ao buscar cupons da filial ${branch_id} da organização ${organization_id}`,
        error.stack,
      );
      throw new HttpException(
        'Erro ao buscar cupons da filial',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Busca detalhes completos de um cupom específico
   * @param organization_id ID da organização
   * @param coupon_id ID do cupom
   * @returns Detalhes completos do cupom
   */
  @Get('organizations/:organization_id/coupons/:coupon_id')
  async getCouponDetail(
    @Param('organization_id') organization_id: string,
    @Param('coupon_id') coupon_id: string,
  ): Promise<AlloyalCouponDetailDto> {
    try {
      return await this.alloyalApiService.getCouponDetail(
        Number(organization_id),
        Number(coupon_id),
      );
    } catch (error) {
      this.logger.error(
        `Erro ao buscar detalhes do cupom ${coupon_id} da organização ${organization_id}`,
        error.stack,
      );
      throw new HttpException(
        'Erro ao buscar detalhes do cupom',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  /* #endregion */
}

import { AlloyalPromotionDto } from 'src/beneficios/dto/alloyal-promotion.dto';
import {
  AlloyalCouponRedeemResponseDto,
  AlloyalCouponOrderResponseDto,
} from 'src/beneficios/dto/alloyal-coupon-redeem.dto';
import { AlloyalCashbackTransferRequestDto } from 'src/beneficios/dto/alloyal-cashback-transfer-request.dto';
import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Headers,
  Logger,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AlloyalApiService } from 'src/beneficios/services/alloyal-api.service';
import { AlloyalCategoryDto } from 'src/beneficios/dto/alloyal-category.dto';
import { AlloyalOrganizationCategoryDto } from 'src/beneficios/dto/alloyal-organization.dto';
import { AlloyalOrganizationListDto } from 'src/beneficios/dto/alloyal-organization-list.dto';
import { AlloyalOrganizationNearestDto } from 'src/beneficios/dto/alloyal-organization-nearest.dto';
import { AlloyalOrganizationHighlightDto } from 'src/beneficios/dto/alloyal-organization-highlight.dto';
import { AlloyalOrganizationHighlightOnlineDto } from 'src/beneficios/dto/alloyal-organization-highlight-online.dto';
import { AlloyalBranchDto } from 'src/beneficios/dto/alloyal-branch.dto';
import { AlloyalOrganizationCouponDto } from 'src/beneficios/dto/alloyal-organization-coupon.dto';
import { AlloyalBranchCouponDto } from 'src/beneficios/dto/alloyal-branch-coupon.dto';
import { AlloyalCouponDetailDto } from 'src/beneficios/dto/alloyal-coupon-detail.dto';
import { AlloyalCashbackRecordsResponseDto } from 'src/beneficios/dto/alloyal-cashback.dto';
import { AlloyalUserDto } from 'src/beneficios/dto/alloyal-user.dto';
import { AlloyalCreateUserRequestDto } from 'src/beneficios/dto/alloyal-create-user.dto';
import { AlloyalUpdateUserRequestDto } from 'src/beneficios/dto/alloyal-update-user.dto';
import {
  AlloyalLoginRequestDto,
  AlloyalLoginResponseDto,
} from 'src/beneficios/dto/alloyal-login.dto';
import { AlloyalSessionHeaders } from 'src/beneficios/services/alloyal-api.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { maskSecret } from 'src/shared/log.util';

/**
 * Controller responsável por expor endpoints da API Alloyal de benefícios
 * Gerencia categorias, organizações, filiais e cupons de desconto
 */
@Controller('alloyal')
@UseGuards(JwtAuthGuard)
export class AlloyalApiController {
  private readonly logger = new Logger(AlloyalApiController.name);
  constructor(private readonly alloyalApiService: AlloyalApiService) {}

  private getSessionHeaders(
    uid?: string,
    client?: string,
    accessToken?: string,
  ): AlloyalSessionHeaders {
    if (!uid || !client || !accessToken) {
      throw new HttpException(
        'Headers de autenticação da Alloyal ausentes (uid, client, access-token)',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return { uid, client, accessToken };
  }

  /**
   * Realiza login na API Alloyal com credenciais do usuário.
   * Retorna os tokens (uid/client/access-token) para serem enviados nas demais rotas.
   */
  @Post('login')
  async login(
    @Body() dto: AlloyalLoginRequestDto,
  ): Promise<AlloyalLoginResponseDto> {
    this.logger.log(
      `[login] Requisição recebida | cpf: ${dto.cpf} | password: ${maskSecret(dto.password)}`,
    );
    try {
      const session = await this.alloyalApiService.login(dto.cpf, dto.password);
      this.logger.log(
        `[login] Sessão obtida com sucesso | uid: ${session.uid} | client: ${maskSecret(session.client)} | accessToken: ${maskSecret(session.accessToken)}`,
      );
      return {
        uid: session.uid,
        client: session.client,
        accessToken: session.accessToken,
      };
    } catch (error) {
      this.logger.error(
        `[login] Falha no login | status upstream: ${error?.response?.status ?? '(sem resposta)'} | data upstream: ${JSON.stringify(error?.response?.data ?? null)}`,
        error.stack,
      );
      throw new HttpException(
        'Erro ao fazer login na API Alloyal',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  /**
   * Endpoint de teste para validar autenticação na API Alloyal
   * @returns Headers de autenticação gerados
   */
  @Get('test-login')
  testLogin(): { message: string } {
    return {
      message: 'Use POST /alloyal/login para autenticar com cpf e password.',
    };
  }

  /**
   * Lista todas as categorias de benefícios disponíveis
   * @returns Array de categorias
   */
  @Get('categories')
  async getCategories(
    @Headers('uid') uid: string,
    @Headers('client') client: string,
    @Headers('access-token') accessToken: string,
  ): Promise<AlloyalCategoryDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getCategories(session);
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
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalOrganizationCategoryDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getOrganizationsByCategory(
        id,
        page ? Number(page) : 1,
        lat,
        lng,
        session,
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
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalOrganizationListDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getOrganizations(
        page ? Number(page) : 1,
        lat,
        lng,
        organization_type,
        search,
        category_id ? Number(category_id) : undefined,
        session,
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
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalOrganizationNearestDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getNearestOrganizations(
        lat,
        lng,
        session,
      );
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
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalBranchDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getBranchesByOrganization(
        Number(organization_id),
        lat,
        lng,
        session,
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
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalOrganizationHighlightDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getHighlightsNearby(
        lat,
        lng,
        session,
      );
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
  async getHighlightsOnline(
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalOrganizationHighlightOnlineDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getHighlightsOnline(session);
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
  @Get('promotions')
  async getPromotions(
    @Query('page') page?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('redeem_type') redeem_type?: string,
    @Query('category_id') category_id?: string,
    @Query('organization_id') organization_id?: string,
    @Query('distance_km') distance_km?: string,
    @Query('term') term?: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalPromotionDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getPromotions(
        page ? Number(page) : undefined,
        lat,
        lng,
        redeem_type,
        category_id ? Number(category_id) : undefined,
        organization_id ? Number(organization_id) : undefined,
        distance_km ? Number(distance_km) : undefined,
        term,
        session,
      );
    } catch (error) {
      this.logger.error('Erro ao buscar promoções', error.stack);
      throw new HttpException(
        'Erro ao buscar promoções',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Lista transações de cashback do usuário (saldo e utilização)
   * @returns Resumo de cashback e lista de transações
   */
  @Get('cashback_records')
  async getCashbackRecords(
    @Headers('uid') uid: string,
    @Headers('client') client: string,
    @Headers('access-token') accessToken: string,
  ): Promise<AlloyalCashbackRecordsResponseDto> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getCashbackRecords(session);
    } catch (error) {
      this.logger.error('Erro ao buscar transações de cashback', error.stack);
      throw new HttpException(
        'Erro ao buscar transações de cashback',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Solicita resgate de cashback para chave PIX vinculada ao CPF
   * @param dto CPF do usuário solicitante
   */
  @Post('cashback_transfer_requests')
  async requestCashbackTransfer(
    @Body() dto: AlloyalCashbackTransferRequestDto,
    @Headers('uid') uid: string,
    @Headers('client') client: string,
    @Headers('access-token') accessToken: string,
  ): Promise<void> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      await this.alloyalApiService.requestCashbackTransfer(dto, session);
    } catch (error) {
      this.logger.error('Erro ao solicitar resgate de cashback', error.stack);
      throw new HttpException(
        'Erro ao solicitar resgate de cashback',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Cria um novo usuário na plataforma Alloyal
   * @param dto Dados do usuário (name, cpf, email, password)
   * @returns Dados do usuário criado
   */
  @Post('users')
  async createUser(
    @Body() dto: AlloyalCreateUserRequestDto,
  ): Promise<AlloyalUserDto> {
    this.logger.log(
      `[createUser] body: ${JSON.stringify({ ...dto, password: maskSecret(dto.password) })}`,
    );
    try {
      return await this.alloyalApiService.createUser(dto);
    } catch (error) {
      this.logger.error('Erro ao criar usuário na API Alloyal', error.stack);
      throw new HttpException(
        'Erro ao criar usuário na API Alloyal',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Atualiza dados de um usuário na plataforma Alloyal
   * @param cpf CPF do usuário a ser atualizado (identificador no path, conforme doc da Alloyal)
   * @param dto Campos a serem atualizados (name, email, cellphone, password, active, user_tags - todos opcionais)
   * @returns Dados atualizados do usuário
   */
  @Patch('users/:cpf')
  async updateUser(
    @Param('cpf') cpf: string,
    @Body() dto: AlloyalUpdateUserRequestDto,
  ): Promise<AlloyalUserDto> {
    this.logger.log(
      `[updateUser] cpf: ${cpf} | body: ${JSON.stringify({ ...dto, ...(dto.password ? { password: maskSecret(dto.password) } : {}) })}`,
    );
    try {
      return await this.alloyalApiService.updateUser(cpf, dto);
    } catch (error) {
      this.logger.error(
        'Erro ao atualizar usuário na API Alloyal',
        error.stack,
      );
      throw new HttpException(
        'Erro ao atualizar usuário na API Alloyal',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Busca usuários associados por CPF
   * @param cpf CPF do usuário (com ou sem caracteres especiais)
   * @returns Array de usuários encontrados ou array vazio
   */
  @Get('users/search/:cpf')
  async searchUserByCpf(@Param('cpf') cpf: string): Promise<AlloyalUserDto[]> {
    try {
      return await this.alloyalApiService.searchUserByCpf(cpf);
    } catch (error) {
      this.logger.error('Erro ao buscar usuário por CPF', error.stack);
      throw new HttpException(
        'Erro ao buscar usuário por CPF',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

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
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalOrganizationCouponDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getOrganizationCoupons(
        Number(organization_id),
        usage_type,
        session,
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
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalBranchCouponDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getBranchCoupons(
        Number(organization_id),
        Number(branch_id),
        page ? Number(page) : 1,
        session,
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
   * Busca detalhes completos de um cupom específico - Esse endpoint por padrão retorna cupons de ativação com url para uso em lojas online no parâmetro activation_url. Caso esse parâmetro esteja vazio, o cupom é para uso em lojas físicas e o código do cupom estará disponível no parâmetro code.
   * @param organization_id ID da organização
   * @param coupon_id ID do cupom
   * @returns Detalhes completos do cupom
   */
  @Get('organizations/:organization_id/coupons/:coupon_id')
  async getCouponDetail(
    @Param('organization_id') organization_id: string,
    @Param('coupon_id') coupon_id: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalCouponDetailDto> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.getCouponDetail(
        Number(organization_id),
        Number(coupon_id),
        session,
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

  /**
   * Resgatar cupom com código (coupon_code)
   * GET /organizations/:organization_id/orders
   */
  @Get('organizations/:organization_id/orders')
  async redeemCouponWithCode(
    @Param('organization_id') organization_id: string,
    @Query('coupon_id') coupon_id: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.redeemCouponWithCode(
        Number(organization_id),
        { coupon_id: Number(coupon_id) },
        session,
      );
    } catch (error) {
      this.logger.error('Erro ao resgatar cupom com código', error.stack);
      throw new HttpException(
        'Erro ao resgatar cupom com código',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Listar todos os resgates de cupom
   * GET /orders
   */
  @Get('orders')
  async listAllCouponOrders(
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalCouponOrderResponseDto[]> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.listAllCouponOrders(session);
    } catch (error) {
      this.logger.error('Erro ao listar resgates de cupons', error.stack);
      throw new HttpException(
        'Erro ao listar resgates de cupons',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Resgatar cupom genérico
   * POST /orders
   */
  @Get('orders/redeem')
  async redeemCouponGeneric(
    @Query('coupon_id') coupon_id: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    try {
      const session = this.getSessionHeaders(uid, client, accessToken);
      return await this.alloyalApiService.redeemCouponGeneric(
        {
          coupon_id: Number(coupon_id),
        },
        session,
      );
    } catch (error) {
      this.logger.error('Erro ao resgatar cupom genérico', error.stack);
      throw new HttpException(
        'Erro ao resgatar cupom genérico',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

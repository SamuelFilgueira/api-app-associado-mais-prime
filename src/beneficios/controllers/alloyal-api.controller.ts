import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AlloyalBranchCouponDto } from 'src/beneficios/dto/alloyal-branch-coupon.dto';
import { AlloyalBranchDto } from 'src/beneficios/dto/alloyal-branch.dto';
import { AlloyalCashbackTransferRequestDto } from 'src/beneficios/dto/alloyal-cashback-transfer-request.dto';
import { AlloyalCashbackRecordsResponseDto } from 'src/beneficios/dto/alloyal-cashback.dto';
import { AlloyalCategoryDto } from 'src/beneficios/dto/alloyal-category.dto';
import { AlloyalCouponDetailDto } from 'src/beneficios/dto/alloyal-coupon-detail.dto';
import {
  AlloyalCouponOrderResponseDto,
  AlloyalCouponRedeemResponseDto,
} from 'src/beneficios/dto/alloyal-coupon-redeem.dto';
import { AlloyalCreateUserRequestDto } from 'src/beneficios/dto/alloyal-create-user.dto';
import {
  AlloyalLoginRequestDto,
  AlloyalLoginResponseDto,
} from 'src/beneficios/dto/alloyal-login.dto';
import { AlloyalOrganizationCouponDto } from 'src/beneficios/dto/alloyal-organization-coupon.dto';
import { AlloyalOrganizationHighlightOnlineDto } from 'src/beneficios/dto/alloyal-organization-highlight-online.dto';
import { AlloyalOrganizationHighlightDto } from 'src/beneficios/dto/alloyal-organization-highlight.dto';
import { AlloyalOrganizationListDto } from 'src/beneficios/dto/alloyal-organization-list.dto';
import { AlloyalOrganizationNearestDto } from 'src/beneficios/dto/alloyal-organization-nearest.dto';
import { AlloyalOrganizationCategoryDto } from 'src/beneficios/dto/alloyal-organization.dto';
import { AlloyalPromotionDto } from 'src/beneficios/dto/alloyal-promotion.dto';
import { AlloyalUpdateUserRequestDto } from 'src/beneficios/dto/alloyal-update-user.dto';
import { AlloyalUserDto } from 'src/beneficios/dto/alloyal-user.dto';
import {
  CabecalhosDaSessao,
  baseDoToken,
  contextoComSessao,
} from 'src/beneficios/helpers/alloyal-contexto';
import {
  RotaAlloyal,
  comErroDeContrato,
} from 'src/beneficios/helpers/alloyal-erro-de-contrato';
import { AlloyalCashbackService } from 'src/beneficios/services/alloyal-cashback.service';
import { AlloyalCatalogoService } from 'src/beneficios/services/alloyal-catalogo.service';
import { AlloyalCuponsService } from 'src/beneficios/services/alloyal-cupons.service';
import { AlloyalSessaoService } from 'src/beneficios/services/alloyal-sessao.service';
import { AlloyalUsuariosService } from 'src/beneficios/services/alloyal-usuarios.service';
import type { BaseOrigin as BaseOriginType } from 'src/config/tenant.config';
import { UsuarioAutenticado } from 'src/infra/auth/usuario-autenticado';
import { BaseOrigin } from 'src/infra/decorators/base-origin.decorator';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { LimiteDeTaxa } from 'src/infra/rate-limit/limite-de-taxa.decorator';
import { SessaoAlloyal } from 'src/integrations/alloyal/alloyal.gateway';

type Requisicao = { user?: UsuarioAutenticado };

/**
 * Rotas do clube de vantagens (Alloyal): sessão, catálogo, cashback,
 * usuário do associado, cupons e pedidos.
 *
 * Cada rota só monta o contexto (base do JWT, sessão da Alloyal vinda dos
 * cabeçalhos, usuário autenticado) e delega ao service do assunto. Toda
 * falha sai com o status e a mensagem fixos da rota — a conversão vive num
 * lugar só, `comErroDeContrato`, e é contrato com o app.
 */
@Controller('alloyal')
@UseGuards(JwtAuthGuard)
export class AlloyalApiController {
  constructor(
    private readonly sessoes: AlloyalSessaoService,
    private readonly catalogo: AlloyalCatalogoService,
    private readonly cashback: AlloyalCashbackService,
    private readonly usuarios: AlloyalUsuariosService,
    private readonly cupons: AlloyalCuponsService,
  ) {}

  /**
   * Rota que usa a sessão do usuário na Alloyal: exige os três cabeçalhos e
   * a base do token (dentro do contrato de erro) e delega.
   */
  private comSessao<T>(
    rota: RotaAlloyal,
    baseOrigin: string | undefined,
    cabecalhos: CabecalhosDaSessao,
    delegar: (base: BaseOriginType, sessao: SessaoAlloyal) => Promise<T>,
  ): Promise<T> {
    return comErroDeContrato(rota, () => {
      const { base, sessao } = contextoComSessao(baseOrigin, cabecalhos);
      return delegar(base, sessao);
    });
  }

  // ---------------------------------------------------------------- sessão

  /**
   * Login na Alloyal com as credenciais do usuário. Devolve
   * uid/client/accessToken, que o app envia como cabeçalhos nas demais rotas.
   */
  @LimiteDeTaxa('autenticacao_alloyal')
  @Post('login')
  login(
    @Body() dto: AlloyalLoginRequestDto,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalLoginResponseDto> {
    return comErroDeContrato('login', async () => {
      const sessao = await this.sessoes.login(
        baseDoToken(baseOrigin),
        dto.cpf,
        dto.password,
      );
      return {
        uid: sessao.uid,
        client: sessao.client,
        accessToken: sessao.accessToken,
      };
    });
  }

  /** Orientação para quem chama a rota antiga de teste. */
  @Get('test-login')
  testLogin(): { message: string } {
    return {
      message: 'Use POST /alloyal/login para autenticar com cpf e password.',
    };
  }

  // -------------------------------------------------------------- catálogo

  /** Categorias de benefícios da base. */
  @Get('categories')
  getCategories(
    @Headers('uid') uid: string,
    @Headers('client') client: string,
    @Headers('access-token') accessToken: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalCategoryDto[]> {
    return this.comSessao(
      'categorias',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) => this.catalogo.categorias(base, sessao),
    );
  }

  /** Organizações de uma categoria (`page`, `lat` e `lng` opcionais). */
  @Get('categories/:id/organizations')
  getOrganizationsByCategory(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalOrganizationCategoryDto[]> {
    return this.comSessao(
      'organizacoesDaCategoria',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.catalogo.organizacoesDaCategoria(base, sessao, id, {
          page,
          lat,
          lng,
        }),
    );
  }

  /**
   * Organizações, com filtros opcionais: página, coordenadas, tipo
   * (online/física), termo de busca e categoria.
   */
  @Get('organizations')
  getOrganizations(
    @Query('page') page?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('organization_type') organization_type?: string,
    @Query('search') search?: string,
    @Query('category_id') category_id?: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalOrganizationListDto[]> {
    return this.comSessao(
      'organizacoes',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.catalogo.organizacoes(base, sessao, {
          page,
          lat,
          lng,
          organization_type,
          search,
          category_id,
        }),
    );
  }

  /**
   * Organizações físicas mais próximas das coordenadas. Para as filiais e o
   * endereço de cada uma, use `organizations/:organization_id/branches`.
   */
  @Get('organizations/nearest')
  getNearestOrganizations(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalOrganizationNearestDto[]> {
    return this.comSessao(
      'organizacoesProximas',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.catalogo.organizacoesProximas(base, sessao, { lat, lng }),
    );
  }

  /** Filiais físicas de uma organização (distância até `lat`/`lng`). */
  @Get('organizations/:organization_id/branches')
  getBranchesByOrganization(
    @Param('organization_id') organization_id: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalBranchDto[]> {
    return this.comSessao(
      'filiais',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.catalogo.filiais(base, sessao, organization_id, { lat, lng }),
    );
  }

  /** Organizações em destaque próximas das coordenadas. */
  @Get('organizations/highlights_nearby')
  getHighlightsNearby(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalOrganizationHighlightDto[]> {
    return this.comSessao(
      'destaquesProximos',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.catalogo.destaquesProximos(base, sessao, { lat, lng }),
    );
  }

  /** Organizações online em destaque. */
  @Get('organizations/highlights_online')
  getHighlightsOnline(
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalOrganizationHighlightOnlineDto[]> {
    return this.comSessao(
      'destaquesOnline',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) => this.catalogo.destaquesOnline(base, sessao),
    );
  }

  /**
   * Promoções. Filtros opcionais: página, coordenadas, `redeem_type`
   * ("physical" ou "online"), categoria, organização, `distance_km` (até 30)
   * e termo de busca.
   */
  @Get('promotions')
  getPromotions(
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
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalPromotionDto[]> {
    return this.comSessao(
      'promocoes',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.catalogo.promocoes(base, sessao, {
          page,
          lat,
          lng,
          redeem_type,
          category_id,
          organization_id,
          distance_km,
          term,
        }),
    );
  }

  // -------------------------------------------------------------- cashback

  /** Saldo e lançamentos de cashback do usuário. */
  @Get('cashback_records')
  getCashbackRecords(
    @Headers('uid') uid: string,
    @Headers('client') client: string,
    @Headers('access-token') accessToken: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalCashbackRecordsResponseDto> {
    return this.comSessao(
      'cashbackExtrato',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) => this.cashback.extrato(base, sessao),
    );
  }

  /** Resgate do cashback para a chave PIX vinculada ao CPF. */
  @Post('cashback_transfer_requests')
  requestCashbackTransfer(
    @Body() dto: AlloyalCashbackTransferRequestDto,
    @Headers('uid') uid: string,
    @Headers('client') client: string,
    @Headers('access-token') accessToken: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<void> {
    return this.comSessao(
      'cashbackResgate',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) => this.cashback.solicitarResgate(base, sessao, dto),
    );
  }

  // ------------------------------------------------- usuário do associado
  // A posse (o associado só mexe no usuário do próprio CPF) é conferida
  // pelo `AlloyalUsuariosService`, antes de qualquer chamada à Alloyal.

  /** Cadastra o associado na Alloyal (name, cpf, email, password). */
  @Post('users')
  createUser(
    @Body() dto: AlloyalCreateUserRequestDto,
    @Request() req: Requisicao,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalUserDto> {
    return comErroDeContrato('usuarioCriar', () =>
      this.usuarios.criar({ usuario: req.user, base: baseOrigin }, dto),
    );
  }

  /**
   * Altera o usuário na Alloyal. O parâmetro se chama `cpf`, mas o app envia
   * o id do usuário na Alloyal; os dois são aceitos.
   */
  @Patch('users/:cpf')
  updateUser(
    @Param('cpf') cpf: string,
    @Body() dto: AlloyalUpdateUserRequestDto,
    @Request() req: Requisicao,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalUserDto> {
    return comErroDeContrato('usuarioAtualizar', () =>
      this.usuarios.atualizar(
        { usuario: req.user, base: baseOrigin },
        cpf,
        dto,
      ),
    );
  }

  /** Usuários da Alloyal com o CPF informado (com ou sem máscara). */
  @Get('users/search/:cpf')
  searchUserByCpf(
    @Param('cpf') cpf: string,
    @Request() req: Requisicao,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalUserDto[]> {
    return comErroDeContrato('usuarioBuscar', () =>
      this.usuarios.buscarPorCpf({ usuario: req.user, base: baseOrigin }, cpf),
    );
  }

  // ------------------------------------------------------ cupons e pedidos

  /** Cupons de uma organização (`usage_type`: online por padrão). */
  @Get('organizations/:organization_id/coupons')
  getOrganizationCoupons(
    @Param('organization_id') organization_id: string,
    @Query('usage_type') usage_type?: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalOrganizationCouponDto[]> {
    return this.comSessao(
      'cuponsDaOrganizacao',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.cupons.cuponsDaOrganizacao(
          base,
          sessao,
          organization_id,
          usage_type,
        ),
    );
  }

  /** Cupons de uma filial (paginado). */
  @Get('organizations/:organization_id/branches/:branch_id/coupons')
  getBranchCoupons(
    @Param('organization_id') organization_id: string,
    @Param('branch_id') branch_id: string,
    @Query('page') page?: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalBranchCouponDto[]> {
    return this.comSessao(
      'cuponsDaFilial',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.cupons.cuponsDaFilial(
          base,
          sessao,
          organization_id,
          branch_id,
          page,
        ),
    );
  }

  /**
   * Detalhe de um cupom. Com `activation_url` preenchida é cupom de loja
   * online; vazia, o cupom é de loja física e o código vem em `code`.
   */
  @Get('organizations/:organization_id/coupons/:coupon_id')
  getCouponDetail(
    @Param('organization_id') organization_id: string,
    @Param('coupon_id') coupon_id: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalCouponDetailDto> {
    return this.comSessao(
      'cupomDetalhe',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.cupons.detalheDoCupom(base, sessao, organization_id, coupon_id),
    );
  }

  /** Resgata um cupom com código (`coupon_id` na query). */
  @Get('organizations/:organization_id/orders')
  redeemCouponWithCode(
    @Param('organization_id') organization_id: string,
    @Query('coupon_id') coupon_id: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    return this.comSessao(
      'cupomResgatarComCodigo',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) =>
        this.cupons.resgatarComCodigo(base, sessao, organization_id, coupon_id),
    );
  }

  /** Resgates de cupom já feitos pelo usuário. */
  @Get('orders')
  listAllCouponOrders(
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalCouponOrderResponseDto[]> {
    return this.comSessao(
      'pedidos',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) => this.cupons.pedidos(base, sessao),
    );
  }

  /** Resgate genérico de um cupom (`coupon_id` na query). */
  @Get('orders/redeem')
  redeemCouponGeneric(
    @Query('coupon_id') coupon_id: string,
    @Headers('uid') uid?: string,
    @Headers('client') client?: string,
    @Headers('access-token') accessToken?: string,
    @BaseOrigin({ opcional: true }) baseOrigin?: BaseOriginType,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    return this.comSessao(
      'cupomResgatar',
      baseOrigin,
      { uid, client, accessToken },
      (base, sessao) => this.cupons.resgatar(base, sessao, coupon_id),
    );
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CreateDirectPartnerCouponDto } from 'src/direct-partners/dto/create-direct-partner-coupon.dto';
import { CreateDirectPartnerDto } from 'src/direct-partners/dto/create-direct-partner.dto';
import { ListDirectPartnersQuery } from 'src/direct-partners/dto/list-direct-partners.query';
import { ListRedemptionsQuery } from 'src/direct-partners/dto/list-redemptions.query';
import { ReorderDirectPartnersDto } from 'src/direct-partners/dto/reorder-direct-partners.dto';
import { UpdateDirectPartnerCouponDto } from 'src/direct-partners/dto/update-direct-partner-coupon.dto';
import { UpdateDirectPartnerDto } from 'src/direct-partners/dto/update-direct-partner.dto';
import { DirectPartnerRedemptionsService } from 'src/direct-partners/services/direct-partner-redemptions.service';
import { DirectPartnersService } from 'src/direct-partners/services/direct-partners.service';
import { AdminPanelRoles } from 'src/infra/decorators/admin-panel-roles.decorator';
import { AdminPanelRole } from 'src/infra/enums/admin-panel-role.enum';
import { AdminPanelRoleGuard } from 'src/infra/guards/admin-panel-role.guard';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

type PanelRequest = Request & { user?: { adminRole?: string } };

/**
 * Rotas do painel administrativo — tela "Parceiros diretos" (§5).
 * Perfil MARKETING (ADMIN sempre passa). As opções do formulário listam
 * todas as bases do deploy: o painel não é limitado à base do operador.
 */
@ApiTags('Parceiros diretos')
@ApiBearerAuth()
@Controller('admin/parceiros-diretos')
@UseGuards(JwtAuthGuard, AdminPanelRoleGuard)
@AdminPanelRoles(AdminPanelRole.MARKETING)
export class DirectPartnersAdminController {
  constructor(
    private readonly service: DirectPartnersService,
    private readonly redemptions: DirectPartnerRedemptionsService,
  ) {}

  // Rotas fixas antes de ":id" para não colidirem com o ParseIntPipe.

  @Get('opcoes')
  @ApiOperation({
    summary:
      'Opções do formulário (bases, categorias, tons, UFs, categorias Alloyal)',
  })
  opcoes() {
    return this.service.opcoes();
  }

  @Patch('ordenar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reordena parceiros (sortOrder = índice no array)' })
  async reordenar(@Body() body: ReorderDirectPartnersDto): Promise<void> {
    await this.service.reordenar(body.ids);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista parceiros (paginado, sem a lista de cupons)',
  })
  listar(@Query() query: ListDirectPartnersQuery) {
    return this.service.listarPainel(query);
  }

  @Post()
  @ApiOperation({ summary: 'Cria parceiro (cupons opcionais no mesmo corpo)' })
  criar(@Body() body: CreateDirectPartnerDto) {
    return this.service.criar(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha parceiro com todos os cupons' })
  detalhar(@Param('id', ParseIntPipe) id: number) {
    return this.service.detalharPainel(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Atualiza parceiro (blocos enviados substituem o bloco inteiro)',
  })
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateDirectPartnerDto,
  ) {
    return this.service.atualizar(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui parceiro (soft por padrão; hard=true só para ADMIN)',
  })
  @ApiQuery({ name: 'hard', required: false, enum: ['true', 'false'] })
  async excluir(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: PanelRequest,
    @Query('hard') hard?: string,
  ): Promise<void> {
    const definitivo =
      typeof hard === 'string' && hard.toLowerCase() === 'true';
    const isPanelAdmin = req.user?.adminRole === AdminPanelRole.ADMIN;
    await this.service.excluir(id, definitivo, isPanelAdmin);
  }

  // ------------------------------------------------------------------ logo

  @Post(':id/logo')
  @ApiOperation({
    summary: 'Envia a logo (JPG/PNG/WebP até 2 MB, campo "logo")',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { logo: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('logo', {
      limits: { fileSize: LOGO_MAX_BYTES },
      fileFilter: (_req, file, callback) => {
        if (!LOGO_MIME_TYPES.includes(file.mimetype)) {
          callback(
            new BadRequestException('Logo deve ser JPG, PNG ou WebP'),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  salvarLogo(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() logo?: Express.Multer.File,
  ) {
    return this.service.salvarLogo(id, logo);
  }

  @Delete(':id/logo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a logo (volta a exibir iniciais)' })
  async removerLogo(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.service.removerLogo(id);
  }

  // ---------------------------------------------------------------- cupons

  @Get(':id/cupons')
  @ApiOperation({
    summary: 'Lista cupons do parceiro (inclusive inativos/vencidos)',
  })
  listarCupons(@Param('id', ParseIntPipe) id: number) {
    return this.service.listarCupons(id);
  }

  @Post(':id/cupons')
  @ApiOperation({ summary: 'Cria cupom' })
  criarCupom(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CreateDirectPartnerCouponDto,
  ) {
    return this.service.criarCupom(id, body);
  }

  @Patch(':id/cupons/:cupomId')
  @ApiOperation({ summary: 'Atualiza cupom (parcial)' })
  atualizarCupom(
    @Param('id', ParseIntPipe) id: number,
    @Param('cupomId', ParseIntPipe) cupomId: number,
    @Body() body: UpdateDirectPartnerCouponDto,
  ) {
    return this.service.atualizarCupom(id, cupomId, body);
  }

  @Delete(':id/cupons/:cupomId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui cupom definitivamente (apaga resgates)' })
  async excluirCupom(
    @Param('id', ParseIntPipe) id: number,
    @Param('cupomId', ParseIntPipe) cupomId: number,
  ): Promise<void> {
    await this.service.excluirCupom(id, cupomId);
  }

  @Get(':id/cupons/:cupomId/resgates')
  @ApiOperation({
    summary: 'Resgates do cupom (quem usou e quando, CPF mascarado)',
  })
  listarResgates(
    @Param('id', ParseIntPipe) id: number,
    @Param('cupomId', ParseIntPipe) cupomId: number,
    @Query() query: ListRedemptionsQuery,
  ) {
    return this.redemptions.listarResgates(id, cupomId, query);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Logger,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

/** Trecho do `request.user` usado para auditoria de quem acionou a rota. */
interface RequestComUsuarioPainel {
  user?: { userId?: number | string; email?: string };
}
import {
  ReinspectionHinovaEnvioOrigem,
  ReinspectionStatus,
} from '@prisma/client';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { ReinspectionService } from 'src/reinspection/services/reinspection.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { CreateReinspectionDto } from 'src/reinspection/dto/create-reinspection.dto';
import { AddPhotosDto } from 'src/reinspection/dto/add-photos.dto';
import { UpsertTemplatePhotoDto } from 'src/reinspection/dto/upsert-template-photo.dto';
import { ListReinspectionsDto } from 'src/reinspection/dto/list-reinspections.dto';
import { ResendPhotoDto } from 'src/reinspection/dto/resend-photo.dto';
import { ReenviarHinovaDto } from 'src/reinspection/dto/reenviar-hinova.dto';
import { AdminPanelRoleGuard } from 'src/infra/guards/admin-panel-role.guard';
import { AdminPanelRoles } from 'src/infra/decorators/admin-panel-roles.decorator';
import {
  AdminPanelRole,
  ALL_ADMIN_PANEL_ROLES,
} from 'src/infra/enums/admin-panel-role.enum';

/**
 * Rotas de revistoria.
 *
 * Dois consumidores compartilham este controller:
 * - App do associado (JWT do app): criar, enviar fotos, submeter, consultar
 *   status/fotos reprovadas/templates, reenviar foto reprovada, marcar
 *   EM_ANALISE e FINALIZADA. Os contratos dessas rotas não devem mudar.
 * - Painel administrativo (JWT do painel, `AdminPanelRoleGuard` + perfil
 *   REVISTORIA): listar, detalhar, aprovar/reprovar fotos, aprovar a
 *   revistoria, templates e o envio/reenvio à Hinova.
 *
 * A ordem das rotas importa: as rotas com segmento fixo (`all`, `totals`,
 * `template`, `status`, `search`, `rejected-photos`, `hinova/...`) ficam
 * antes de `:id` para o Express não capturá-las como id.
 */
@UseGuards(JwtAuthGuard)
@Controller('reinspection')
export class ReinspectionController {
  private readonly logger = new Logger(ReinspectionController.name);
  constructor(
    private readonly reinspectionService: ReinspectionService,
    private readonly reinspectionHinovaService: ReinspectionHinovaService,
    private readonly boletoReativacaoService: BoletoReativacaoService,
  ) {}

  // ── App ───────────────────────────────────────────────────────────────────

  /**
   * Cria uma revistoria sem fotos. O frontend deve usar POST /:id/photos
   * para enviar as fotos em lotes e POST /:id/submit para finalizar.
   */
  @Post()
  async create(
    @Body() dto: CreateReinspectionDto,
    @Req() req: any,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.create(dto, req.user.id, debugId);
  }

  /**
   * Adiciona um lote de fotos (máx. 10) a uma revistoria existente com status PENDENTE.
   * Pode ser chamado múltiplas vezes para envio incremental, evitando erro 413.
   * Body: { photos: [{ nomeArquivo, binario, codigoTipo?, templatePhotoId? }] }
   */
  @Post(':id/photos')
  @HttpCode(HttpStatus.OK)
  addPhotos(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddPhotosDto,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.addPhotos(id, dto, debugId);
  }

  /**
   * Finaliza o envio das fotos (dispara o e-mail para os analistas).
   * Requer ao menos uma foto e status PENDENTE. Não altera o status;
   * o app chama PATCH /status em seguida.
   */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submitReinspection(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.submitReinspection(id, debugId);
  }

  // ── Painel: listagens ─────────────────────────────────────────────────────

  /**
   * Lista revistorias da mais recente para a mais antiga.
   * Query param opcional: limit (padrão 20)
   */
  @Get()
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  listRecent(@Query() query: ListReinspectionsDto) {
    return this.reinspectionService.listRecent(query.limit);
  }

  @Get('all')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  listAll() {
    return this.reinspectionService.listAll();
  }

  @Get('totals')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(...ALL_ADMIN_PANEL_ROLES)
  @HttpCode(HttpStatus.OK)
  getDashboardTotals() {
    return this.reinspectionService.getDashboardTotals();
  }

  /**
   * Cria ou atualiza uma foto de template para um tipo de revistoria e ordem específicos.
   * Body (multipart/form-data): vehicleType, ordem, photo (arquivo)
   */
  @Patch('template')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('photo'))
  async upsertTemplatePhoto(
    @Body() dto: UpsertTemplatePhotoDto,
    @UploadedFile() file: any,
  ) {
    return this.reinspectionService.upsertTemplatePhoto(dto, file);
  }

  /**
   * Retorna as fotos de template cadastradas, ordenadas por "ordem".
   * Usada pelo app e pelo painel (somente JWT).
   * Query param opcional: vehicleType (VEICULOS_LEVES | MOTOS | CAMINHOES)
   */
  @Get('template')
  @HttpCode(HttpStatus.OK)
  getTemplatePhotos(@Query('vehicleType') vehicleType?: string) {
    return this.reinspectionService.getTemplatePhotos(vehicleType);
  }

  /**
   * Retorna o status da última revistoria para um veículo específico.
   * Usada pelo app e pelo painel (somente JWT).
   * Query param obrigatório: userVehicleId
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  getStatusByUserVehicleId(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
  ) {
    return this.reinspectionService.getStatusByUserVehicleId(userVehicleId);
  }

  @Get('search')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  searchByChassiOrPlate(
    @Query('chassi') chassi?: string,
    @Query('plate') plate?: string,
  ) {
    return this.reinspectionService.searchByChassiOrPlate(chassi, plate);
  }

  /**
   * Marca a última revistoria do veículo como EM_ANALISE (chamada pelo app
   * logo após o submit).
   */
  @Patch('status')
  @HttpCode(HttpStatus.OK)
  updateStatusByUserVehicleId(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
  ) {
    return this.reinspectionService.updateStatusByUserVehicleId(userVehicleId);
  }

  /**
   * Retorna somente as fotos reprovadas da última revistoria de um veículo,
   * junto com a foto de template correspondente. Usada pelo app e pelo painel.
   * Query param obrigatório: userVehicleId
   */
  @Get('rejected-photos')
  @HttpCode(HttpStatus.OK)
  getRejectedPhotos(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
  ) {
    return this.reinspectionService.getRejectedPhotos(userVehicleId);
  }

  // ── Painel: envio à Hinova ────────────────────────────────────────────────

  /**
   * Revistorias aprovadas/finalizadas com fotos ainda não inseridas na Hinova.
   */
  @Get('hinova/pendentes')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  listarPendentesHinova() {
    return this.reinspectionHinovaService.listarPendentes();
  }

  /**
   * Histórico de tentativas de envio à Hinova de uma revistoria.
   */
  @Get(':id/hinova/envios')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  listarEnviosHinova(@Param('id', ParseIntPipe) id: number) {
    return this.reinspectionHinovaService.listarEnvios(id);
  }

  /**
   * Reenvia manualmente à Hinova as fotos pendentes (ou as `photoIds`
   * informadas) de uma revistoria APROVADA/FINALIZADA. Cada chamada gera
   * uma linha de auditoria com o usuário do painel que disparou.
   * Body opcional: { photoIds?: number[], forcar?: boolean }
   */
  @Post(':id/hinova/reenviar')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  async reenviarHinova(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReenviarHinovaDto,
    @Req() req: RequestComUsuarioPainel,
    @Headers('x-debug-id') debugId?: string,
  ) {
    const resultado = await this.reinspectionHinovaService.enviarFotos(id, {
      origem: ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL,
      adminPanelUserId: Number(req.user?.userId) || undefined,
      adminPanelUserEmail: req.user?.email,
      photoIds: dto.photoIds,
      forcar: dto.forcar === true,
      debugId,
    });

    if (!resultado) {
      return {
        reinspectionId: id,
        envioId: null,
        status: null,
        totalFotos: 0,
        totalInseridas: 0,
        totalFalhas: 0,
        fotos: [],
        mensagem:
          'Nenhuma foto pendente de envio. Use forcar=true para reenviar fotos já inseridas.',
      };
    }

    return resultado;
  }

  // ── Painel: boleto de reativação ──────────────────────────────────────────

  /**
   * Revistorias aprovadas cujo boleto de reativação está aguardando retry
   * ou falhou de vez.
   */
  @Get('boleto/pendentes')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA, AdminPanelRole.COBRANCA)
  @HttpCode(HttpStatus.OK)
  listarPendentesBoleto() {
    return this.boletoReativacaoService.listarPendentes();
  }

  /**
   * Dispara agora uma tentativa de criação do boleto de reativação
   * (mesma lógica do retry: adota boleto já existente no SGA ou cadastra).
   * Só para revistoria APROVADA que já passou pelo fluxo automático
   * (PENDENTE_RETRY/FALHA). Revistoria aprovada antes desta versão
   * (NAO_GERADO) responde `pulado = true` e nunca gera boleto retroativo.
   */
  @Post(':id/boleto/gerar')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA, AdminPanelRole.COBRANCA)
  @HttpCode(HttpStatus.OK)
  async gerarBoleto(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-debug-id') debugId?: string,
  ) {
    const reinspection = await this.reinspectionService.getById(id);
    if (reinspection.status !== ReinspectionStatus.APROVADA) {
      throw new BadRequestException(
        'Somente revistorias APROVADA podem gerar boleto de reativação',
      );
    }
    return this.boletoReativacaoService.processar(id, {
      origem: 'MANUAL',
      debugId,
    });
  }

  // ── Painel: detalhe e avaliação ───────────────────────────────────────────

  /**
   * Retorna as fotos de uma revistoria específica.
   */
  @Get(':id/photos')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  getPhotosByReinspectionId(@Param('id', ParseIntPipe) id: number) {
    return this.reinspectionService.getPhotosByReinspectionId(id);
  }

  /**
   * Finaliza a última revistoria de um veículo específico.
   * Usada pelo app (veículo voltou a ATIVO no SGA) e pelo painel.
   * Query param obrigatório: userVehicleId
   */
  @Patch('finalizar')
  @HttpCode(HttpStatus.OK)
  finalizeByUserVehicleId(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.finalizeByUserVehicleId(
      userVehicleId,
      debugId,
    );
  }

  /**
   * Aprova a última revistoria de um veículo específico e envia as fotos
   * pendentes à Hinova (resultado registrado em ReinspectionHinovaEnvio).
   * Query param obrigatório: userVehicleId
   */
  @Patch('aprovar')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  approveByUserVehicleId(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
    @Req() req: RequestComUsuarioPainel,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.approveByUserVehicleId(
      userVehicleId,
      debugId,
      {
        userId: Number(req.user?.userId) || undefined,
        email: req.user?.email,
      },
    );
  }

  /**
   * Reprova uma foto específica de revistoria e reprova a revistoria associada.
   */
  @Patch('photos/:photoId/reprove')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  reprovePhoto(@Param('photoId', ParseIntPipe) photoId: number) {
    return this.reinspectionService.reprovePhoto(photoId);
  }

  /**
   * Aprova uma foto específica de revistoria e atualiza a revistoria associada.
   */
  @Patch('photos/:photoId/approve')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  approvePhoto(@Param('photoId', ParseIntPipe) photoId: number) {
    return this.reinspectionService.approvePhoto(photoId);
  }

  /**
   * Reenvia uma foto reprovada com a nova imagem em base64 (app).
   * Atualiza a foto, volta a revistoria para EM_ANALISE e dispara e-mail
   * com assunto específico. O envio à Hinova acontece na próxima aprovação.
   * Body: { base64: string }
   */
  @Patch('photos/:photoId/resend')
  @HttpCode(HttpStatus.OK)
  resendPhoto(
    @Param('photoId', ParseIntPipe) photoId: number,
    @Body() dto: ResendPhotoDto,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.resendPhoto(photoId, dto.base64, debugId);
  }

  /**
   * Detalhe de uma revistoria pelo id (painel). Declarada por último para
   * não capturar as rotas com segmento fixo.
   */
  @Get(':id')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  getById(@Param('id', ParseIntPipe) id: number) {
    return this.reinspectionService.getById(id);
  }
}

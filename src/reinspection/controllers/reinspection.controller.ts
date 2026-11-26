import {
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { UsuarioAutenticado } from 'src/infra/auth/usuario-autenticado';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { ReinspectionService } from 'src/reinspection/services/reinspection.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { RevistoriaRegraService } from 'src/reinspection/services/revistoria-regra.service';
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

/** `request.user` montado pelo `JwtStrategy` (app ou painel). */
interface RequisicaoAutenticada {
  user: UsuarioAutenticado;
}

/** Usuário do painel que acionou a rota, para a auditoria. */
function atorDoPainel(req: RequisicaoAutenticada) {
  return {
    userId: Number(req.user?.userId) || undefined,
    email: req.user?.email,
  };
}

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
 * Posse: nas rotas do app o associado só alcança revistoria de veículo
 * dele (`userVehicle.userId`); token com `role` ADMIN (painel e ADMIN
 * legado) é isento. A checagem fica nos casos de uso, que recebem
 * `req.user`.
 *
 * A ordem das rotas importa: as rotas com segmento fixo (`all`, `totals`,
 * `template`, `regra`, `regras`, `status`, `search`, `rejected-photos`, `hinova/...`) ficam
 * antes de `:id` para o Express não capturá-las como id.
 */
@UseGuards(JwtAuthGuard)
@Controller('reinspection')
export class ReinspectionController {
  constructor(
    private readonly reinspectionService: ReinspectionService,
    private readonly reinspectionHinovaService: ReinspectionHinovaService,
    private readonly boletoReativacaoService: BoletoReativacaoService,
    private readonly revistoriaRegraService: RevistoriaRegraService,
  ) {}

  // ── App ───────────────────────────────────────────────────────────────────

  /**
   * Cria uma revistoria sem fotos. O frontend deve usar POST /:id/photos
   * para enviar as fotos em lotes e POST /:id/submit para finalizar.
   */
  @Post()
  create(
    @Body() dto: CreateReinspectionDto,
    @Req() req: RequisicaoAutenticada,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.create(dto, req.user, debugId);
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
    @Req() req: RequisicaoAutenticada,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.addPhotos(id, dto, req.user, debugId);
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
    @Req() req: RequisicaoAutenticada,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.submitReinspection(id, req.user, debugId);
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
  upsertTemplatePhoto(
    @Body() dto: UpsertTemplatePhotoDto,
    @UploadedFile() file: Express.Multer.File,
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
   * Regra de revistoria da base do usuário logado (JWT do app): situações do
   * veículo que exigem revistoria e o template de fotos de cada tipo do SGA.
   * Ver `src/config/revistoria-regra.config.ts`.
   */
  @Get('regra')
  @HttpCode(HttpStatus.OK)
  getRegra(@Req() req: { user?: { baseOrigin?: string } }) {
    return this.revistoriaRegraService.getRegra(req.user?.baseOrigin);
  }

  /** Regras de revistoria de todas as bases deste deploy (painel). */
  @Get('regras')
  @UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(...ALL_ADMIN_PANEL_ROLES)
  @HttpCode(HttpStatus.OK)
  getRegras() {
    return this.revistoriaRegraService.getRegras();
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
    @Req() req: RequisicaoAutenticada,
  ) {
    return this.reinspectionService.getStatusByUserVehicleId(
      userVehicleId,
      req.user,
    );
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
    @Req() req: RequisicaoAutenticada,
  ) {
    return this.reinspectionService.updateStatusByUserVehicleId(
      userVehicleId,
      req.user,
    );
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
    @Req() req: RequisicaoAutenticada,
  ) {
    return this.reinspectionService.getRejectedPhotos(userVehicleId, req.user);
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
  reenviarHinova(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReenviarHinovaDto,
    @Req() req: RequisicaoAutenticada,
    @Headers('x-debug-id') debugId?: string,
  ) {
    const ator = atorDoPainel(req);
    return this.reinspectionHinovaService.reenviar(id, {
      adminPanelUserId: ator.userId,
      adminPanelUserEmail: ator.email,
      photoIds: dto.photoIds,
      forcar: dto.forcar === true,
      debugId,
    });
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
  gerarBoleto(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.gerarBoleto(id, debugId);
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
    @Req() req: RequisicaoAutenticada,
  ) {
    return this.reinspectionService.finalizeByUserVehicleId(
      userVehicleId,
      req.user,
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
    @Req() req: RequisicaoAutenticada,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.approveByUserVehicleId(
      userVehicleId,
      debugId,
      atorDoPainel(req),
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
    @Req() req: RequisicaoAutenticada,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.resendPhoto(
      photoId,
      dto.base64,
      req.user,
      debugId,
    );
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

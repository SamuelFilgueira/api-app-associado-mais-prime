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
  Logger,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { AdminRoleGuard } from 'src/auth/guards/admin-role.guard';
import { ReinspectionService } from 'src/reinspection/services/reinspection.service';
import { CreateReinspectionDto } from 'src/reinspection/dto/create-reinspection.dto';
import { AddPhotosDto } from 'src/reinspection/dto/add-photos.dto';
import { UpsertTemplatePhotoDto } from 'src/reinspection/dto/upsert-template-photo.dto';
import { ListReinspectionsDto } from 'src/reinspection/dto/list-reinspections.dto';
import { ResendPhotoDto } from 'src/reinspection/dto/resend-photo.dto';
import { AdminPanelRoleGuard } from 'src/admin-panel/guards/admin-panel-role.guard';
import { AdminPanelRoles } from 'src/admin-panel/decorators/admin-panel-roles.decorator';
import {
  AdminPanelRole,
  ALL_ADMIN_PANEL_ROLES,
} from 'src/admin-panel/enums/admin-panel-role.enum';

@UseGuards(JwtAuthGuard)
@Controller('reinspection')
export class ReinspectionController {
  private readonly logger = new Logger(ReinspectionController.name);
  constructor(private readonly reinspectionService: ReinspectionService) {}

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
   * Finaliza a revistoria após todas as fotos serem enviadas.
   * Dispara o e-mail de notificação para os analistas.
   * Requer ao menos uma foto e status PENDENTE.
   */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submitReinspection(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.submitReinspection(id, debugId);
  }

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
   * Restrito a administradores.
   * Body (multipart/form-data): vehicleType, ordem, photo (arquivo)
   */
  @Patch('template')
  @UseGuards(AdminRoleGuard, AdminPanelRoleGuard)
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
   * Query param opcional: vehicleType (VEICULOS_LEVES | MOTOS | CAMINHOES)
   */
  @Get('template')
  // @UseGuards(AdminPanelRoleGuard)
  // @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  getTemplatePhotos(@Query('vehicleType') vehicleType?: string) {
    return this.reinspectionService.getTemplatePhotos(vehicleType);
  }

  /**
   * Retorna o status da última revistoria para um veículo específico.
   * Query param obrigatório: userVehicleId
   */
  @Get('status')
  // @UseGuards(AdminPanelRoleGuard)
  // @AdminPanelRoles(AdminPanelRole.REVISTORIA)
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

  @Patch('status')
  @HttpCode(HttpStatus.OK)
  updateStatusByUserVehicleId(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
  ) {
    return this.reinspectionService.updateStatusByUserVehicleId(userVehicleId);
  }

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
   * Aprova a última revistoria de um veículo específico.
   * Query param obrigatório: userVehicleId
   */
  @Patch('aprovar')
  @HttpCode(HttpStatus.OK)
  approveByUserVehicleId(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
    @Headers('x-debug-id') debugId?: string,
  ) {
    return this.reinspectionService.approveByUserVehicleId(
      userVehicleId,
      debugId,
    );
  }

  /**
   * Reprova uma foto específica de revistoria e reprova a revistoria associada.
   */
  @Patch('photos/:photoId/reprove')
  @HttpCode(HttpStatus.OK)
  reprovePhoto(@Param('photoId', ParseIntPipe) photoId: number) {
    return this.reinspectionService.reprovePhoto(photoId);
  }

  /**
   * Aprova uma foto específica de revistoria e atualiza a revistoria associada.
   */
  @Patch('photos/:photoId/approve')
  @HttpCode(HttpStatus.OK)
  approvePhoto(@Param('photoId', ParseIntPipe) photoId: number) {
    return this.reinspectionService.approvePhoto(photoId);
  }

  /**
   * Retorna somente as fotos reprovadas da última revistoria de um veículo,
   * junto com a foto de template correspondente.
   * Query param obrigatório: userVehicleId
   */
  @Get('rejected-photos')
  //@UseGuards(AdminPanelRoleGuard)
  @AdminPanelRoles(AdminPanelRole.REVISTORIA)
  @HttpCode(HttpStatus.OK)
  getRejectedPhotos(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
  ) {
    return this.reinspectionService.getRejectedPhotos(userVehicleId);
  }

  /**
   * Reenvia uma foto reprovada com a nova imagem em base64.
   * Atualiza a foto, volta a revistoria para EM_ANALISE,
   * reenvia para a Hinova e dispara e-mail com assunto específico.
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
}

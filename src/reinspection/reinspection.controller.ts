import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { ReinspectionService } from './reinspection.service';
import { CreateReinspectionDto } from './dto/create-reinspection.dto';
import { UpsertTemplatePhotoDto } from './dto/upsert-template-photo.dto';
import { ListReinspectionsDto } from './dto/list-reinspections.dto';
import { ResendPhotoDto } from './dto/resend-photo.dto';

@UseGuards(JwtAuthGuard)
@Controller('reinspection')
export class ReinspectionController {
  constructor(private readonly reinspectionService: ReinspectionService) {}

  /**
   * Cria uma revistoria, persiste as fotos como log e as envia para a Hinova.
   * O app deve comprimir as fotos e convertê-las para base64 antes de enviar.
   */
  @Post()
  async create(@Body() dto: CreateReinspectionDto) {
    return this.reinspectionService.create(dto);
  }

  /**
   * Lista revistorias da mais recente para a mais antiga.
   * Query param opcional: limit (padrão 20)
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  listRecent(@Query() query: ListReinspectionsDto) {
    return this.reinspectionService.listRecent(query.limit);
  }

  @Get('all')
  @HttpCode(HttpStatus.OK)
  listAll() {
    return this.reinspectionService.listAll();
  }

  /**
   * Cria ou atualiza uma foto de template para um tipo de revistoria e ordem específicos.
   * Restrito a administradores.
   * Body (multipart/form-data): vehicleType, ordem, photo (arquivo)
   */
  @Patch('template')
  @UseGuards(AdminRoleGuard)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('photo'))
  async upsertTemplatePhoto(
    @Body() dto: UpsertTemplatePhotoDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.reinspectionService.upsertTemplatePhoto(dto, file);
  }

  /**
   * Retorna as fotos de template cadastradas, ordenadas por "ordem".
   * Query param opcional: vehicleType (VEICULOS_LEVES | MOTOS | CAMINHOES)
   */
  @Get('template')
  @HttpCode(HttpStatus.OK)
  getTemplatePhotos(@Query('vehicleType') vehicleType?: string) {
    return this.reinspectionService.getTemplatePhotos(vehicleType);
  }

  /**
   * Retorna o status da última revistoria para um veículo específico.
   * Query param obrigatório: userVehicleId
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  getStatusByUserVehicleId(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
  ) {
    return this.reinspectionService.getStatusByUserVehicleId(userVehicleId);
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
  ) {
    console.log(
      `Recebido pedido para finalizar revistoria do userVehicleId: ${userVehicleId}`,
    );
    return this.reinspectionService.finalizeByUserVehicleId(userVehicleId);
  }

  /**
   * Aprova a última revistoria de um veículo específico.
   * Query param obrigatório: userVehicleId
   */
  @Patch('aprovar')
  @HttpCode(HttpStatus.OK)
  approveByUserVehicleId(
    @Query('userVehicleId', ParseIntPipe) userVehicleId: number,
  ) {
    return this.reinspectionService.approveByUserVehicleId(userVehicleId);
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
  ) {
    return this.reinspectionService.resendPhoto(photoId, dto.base64);
  }
}

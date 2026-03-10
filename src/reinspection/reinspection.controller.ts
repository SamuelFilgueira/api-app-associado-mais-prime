import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
}

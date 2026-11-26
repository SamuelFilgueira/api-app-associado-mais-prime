import { BadRequestException, Injectable } from '@nestjs/common';
import { ReinspectionVehicleType } from '@prisma/client';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { UpsertTemplatePhotoDto } from 'src/reinspection/dto/upsert-template-photo.dto';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';

/** Fotos de template (o exemplo que o associado segue em cada ordem). */
@Injectable()
export class ReinspectionTemplateService {
  constructor(
    private readonly fotos: ReinspectionPhotoRepository,
    private readonly arquivos: FileUploadService,
  ) {}

  /** Cria ou troca a foto de template de um tipo de veículo + ordem. */
  async salvar(dto: UpsertTemplatePhotoDto, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Foto do template é obrigatória');
    }

    const photoUrl = await this.arquivos.uploadReinspectionTemplatePhoto(file);

    // Se já existe um registro com esse tipo + ordem, remove a foto antiga.
    const existente = await this.fotos.template(dto.vehicleType, dto.ordem);
    if (existente) {
      await this.arquivos.deleteReinspectionTemplatePhoto(existente.photoUrl);
    }

    const salvo = await this.fotos.salvarTemplate(
      dto.vehicleType,
      dto.ordem,
      photoUrl,
    );
    return {
      id: salvo.id,
      vehicleType: salvo.vehicleType,
      ordem: salvo.ordem,
      photoUrl: this.arquivos.buildUrl(salvo.photoUrl),
    };
  }

  /** Templates cadastrados, por ordem; opcionalmente de um tipo só. */
  async listar(vehicleType?: string) {
    const templates = await this.fotos.listarTemplates(
      vehicleType ? (vehicleType as ReinspectionVehicleType) : undefined,
    );
    return templates.map((template) => ({
      ...template,
      photoUrl: this.arquivos.buildUrl(template.photoUrl),
    }));
  }
}

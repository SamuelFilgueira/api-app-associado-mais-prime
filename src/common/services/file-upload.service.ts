import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

@Injectable()
export class FileUploadService {
  private readonly logger = new Logger(FileUploadService.name);

  private readonly uploadPath = join(
    process.cwd(),
    'uploads',
    'profile-photos',
  );
  private readonly workshopUploadPath = join(
    process.cwd(),
    'uploads',
    'workshop-photos',
  );
  private readonly reinspectionPhotosUploadPath = join(
    process.cwd(),
    'uploads',
    'reinspection-photos',
  );
  private readonly sliderUploadPath = join(
    process.cwd(),
    'uploads',
    'slider-photos',
  );

  async uploadProfilePhoto(file: Express.Multer.File): Promise<string> {
    // Garante que o diretório de upload existe
    await this.ensureDirectory(this.uploadPath);

    // Gera um nome único para o arquivo
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const filename = `profile-${timestamp}-${randomString}.jpg`;
    const filepath = join(this.uploadPath, filename);

    // Processa e comprime a imagem usando sharp
    // Redimensiona para no máximo 800x800px mantendo a proporção
    // Comprime com qualidade 85 (bom equilíbrio entre qualidade e tamanho)
    await sharp(file.buffer)
      .resize(800, 800, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, progressive: true })
      .toFile(filepath);

    // Retorna o caminho relativo para armazenar no banco
    return `uploads/profile-photos/${filename}`;
  }

  async uploadWorkshopPhoto(
    file: Express.Multer.File,
    kind: 'front' | 'back',
  ): Promise<string> {
    await this.ensureDirectory(this.workshopUploadPath);

    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const filename = `workshop-${kind}-${timestamp}-${randomString}.jpg`;
    const filepath = join(this.workshopUploadPath, filename);

    await sharp(file.buffer)
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, progressive: true })
      .toFile(filepath);

    return `uploads/workshop-photos/${filename}`;
  }

  async uploadSliderPhoto(file: Express.Multer.File): Promise<string> {
    await this.ensureDirectory(this.sliderUploadPath);

    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const filename = `slider-${timestamp}-${randomString}.jpg`;
    const filepath = join(this.sliderUploadPath, filename);

    await sharp(file.buffer)
      .resize(1600, 900, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, progressive: true })
      .toFile(filepath);

    return `uploads/slider-photos/${filename}`;
  }

  async deleteProfilePhoto(photoUrl: string): Promise<void> {
    if (!photoUrl) return;

    try {
      const filepath = join(process.cwd(), photoUrl);
      await fs.unlink(filepath);
    } catch (error) {
      // Ignora erros se o arquivo não existir
      this.logger.warn(`Erro ao deletar foto: ${error.message}`);
    }
  }

  async deleteWorkshopPhoto(photoUrl: string): Promise<void> {
    if (!photoUrl) return;

    try {
      const filepath = join(process.cwd(), photoUrl);
      await fs.unlink(filepath);
    } catch (error) {
      this.logger.warn(`Erro ao deletar foto: ${error.message}`);
    }
  }

  async deleteSliderPhoto(photoUrl: string): Promise<void> {
    if (!photoUrl) return;

    try {
      const filepath = join(process.cwd(), photoUrl);
      await fs.unlink(filepath);
    } catch (error) {
      this.logger.warn(`Erro ao deletar foto de slider: ${error.message}`);
    }
  }

  async uploadReinspectionTemplatePhoto(
    file: Express.Multer.File,
  ): Promise<string> {
    const templateUploadPath = join(
      process.cwd(),
      'uploads',
      'reinspection-templates',
    );
    await this.ensureDirectory(templateUploadPath);

    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const filename = `template-${timestamp}-${randomString}.jpg`;
    const filepath = join(templateUploadPath, filename);

    await sharp(file.buffer)
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, progressive: true })
      .toFile(filepath);

    return `uploads/reinspection-templates/${filename}`;
  }

  async deleteReinspectionTemplatePhoto(photoUrl: string): Promise<void> {
    if (!photoUrl) return;

    try {
      const filepath = join(process.cwd(), photoUrl);
      await fs.unlink(filepath);
    } catch (error) {
      this.logger.warn(`Erro ao deletar template foto: ${error.message}`);
    }
  }

  async uploadReinspectionPhotoFromBase64(
    base64Content: string,
    originalName: string,
  ): Promise<string> {
    await this.ensureDirectory(this.reinspectionPhotosUploadPath);

    const cleanedBase64 = base64Content.includes(',')
      ? base64Content.split(',')[1]
      : base64Content;

    const buffer = Buffer.from(cleanedBase64, 'base64');

    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const sanitizedName = this.sanitizeFilename(originalName);
    const filename = `reinspection-${timestamp}-${randomString}-${sanitizedName}`;
    const filepath = join(this.reinspectionPhotosUploadPath, filename);

    await fs.writeFile(filepath, buffer);

    return `uploads/reinspection-photos/${filename}`;
  }

  private sanitizeFilename(filename: string): string {
    const trimmed = filename?.trim() || 'photo.jpg';
    return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private async ensureDirectory(pathToCheck: string): Promise<void> {
    try {
      await fs.access(pathToCheck);
    } catch {
      await fs.mkdir(pathToCheck, { recursive: true });
    }
  }
}

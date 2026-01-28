import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

@Injectable()
export class FileUploadService {
  private readonly uploadPath = join(
    process.cwd(),
    'uploads',
    'profile-photos',
  );

  async uploadProfilePhoto(file: Express.Multer.File): Promise<string> {
    // Garante que o diretório de upload existe
    await this.ensureUploadDirectory();

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

  async deleteProfilePhoto(photoUrl: string): Promise<void> {
    if (!photoUrl) return;

    try {
      const filepath = join(process.cwd(), photoUrl);
      await fs.unlink(filepath);
    } catch (error) {
      // Ignora erros se o arquivo não existir
      console.warn(`Erro ao deletar foto: ${error.message}`);
    }
  }

  private async ensureUploadDirectory(): Promise<void> {
    try {
      await fs.access(this.uploadPath);
    } catch {
      await fs.mkdir(this.uploadPath, { recursive: true });
    }
  }
}

import { Injectable } from '@nestjs/common';
import { LocalStorageProvider } from './providers/local-storage.provider';

@Injectable()
export class StorageService {
  private readonly provider = new LocalStorageProvider();

  /**
   * Salva um buffer no filesystem local.
   * @param buffer  Conteúdo do arquivo
   * @param subdir  Subdiretório dentro de /uploads (ex: 'profile-photos')
   * @param filename Nome do arquivo (ex: 'profile-123.jpg')
   * @returns Caminho relativo armazenável (ex: 'uploads/profile-photos/profile-123.jpg')
   */
  async save(buffer: Buffer, subdir: string, filename: string): Promise<string> {
    return this.provider.save(buffer, subdir, filename);
  }

  /**
   * Remove um arquivo pelo caminho relativo armazenado no banco.
   */
  async delete(relativePath: string): Promise<void> {
    return this.provider.delete(relativePath);
  }

  /**
   * Retorna a URL pública para um caminho relativo.
   */
  getUrl(relativePath: string): string {
    return this.provider.getUrl(relativePath);
  }
}

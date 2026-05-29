import { promises as fs } from 'fs';
import { join, extname } from 'path';

export class LocalStorageProvider {
  async save(
    buffer: Buffer,
    subdir: string,
    filename: string,
  ): Promise<string> {
    const dir = join(process.cwd(), 'uploads', subdir);
    await fs.mkdir(dir, { recursive: true });
    const filepath = join(dir, filename);
    await fs.writeFile(filepath, buffer);
    return `uploads/${subdir}/${filename}`;
  }

  async delete(relativePath: string): Promise<void> {
    if (!relativePath) return;
    try {
      const filepath = join(process.cwd(), relativePath);
      await fs.unlink(filepath);
    } catch {
      // silently ignore — file may not exist
    }
  }

  getUrl(relativePath: string): string {
    return `/${relativePath}`;
  }
}

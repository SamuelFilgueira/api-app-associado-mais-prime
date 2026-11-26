import { promises as fs } from 'fs';
import { resolve } from 'path';
import { FileUploadService } from 'src/infra/storage/file-upload.service';

/**
 * Exclusão e nome de arquivo de upload: caminho vindo do banco/cliente não
 * pode sair de `uploads/`, e extensão ativa não é gravada como veio.
 */
describe('FileUploadService — contenção em uploads/', () => {
  let service: FileUploadService;
  let unlink: jest.SpyInstance;

  beforeEach(() => {
    service = new FileUploadService();
    unlink = jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('remove arquivo dentro de uploads/', async () => {
    await service.deleteProfilePhoto('uploads/profile-photos/profile-1.jpg');

    expect(unlink).toHaveBeenCalledWith(
      resolve(process.cwd(), 'uploads/profile-photos/profile-1.jpg'),
    );
  });

  it('aceita o caminho público com barra inicial', async () => {
    await service.deleteDirectPartnerLogo('/uploads/direct-partners/9-1.webp');

    expect(unlink).toHaveBeenCalledWith(
      resolve(process.cwd(), 'uploads/direct-partners/9-1.webp'),
    );
  });

  it.each([
    '../.env',
    'uploads/../.env',
    'uploads/profile-photos/../../package.json',
    '/etc/passwd',
    'uploadsX/arquivo.jpg',
  ])('recusa caminho fora de uploads/: %s', async (caminho) => {
    await service.deleteProfilePhoto(caminho);
    await service.deleteWorkshopPhoto(caminho);
    await service.deleteSliderPhoto(caminho);
    await service.deleteReinspectionTemplatePhoto(caminho);

    expect(unlink).not.toHaveBeenCalled();
  });

  it('documento com extensão ativa é gravado como .bin', async () => {
    const writeFile = jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);

    const url = await service.uploadDocumentFile({
      originalname: 'pagina.html',
      buffer: Buffer.from('<script>alert(1)</script>'),
    } as Express.Multer.File);

    expect(url).toMatch(/^\/uploads\/\d+-[0-9a-f]{16}-pagina\.bin$/);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('documento PDF mantém a extensão', async () => {
    jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);

    const url = await service.uploadDocumentFile({
      originalname: 'Regulamento 2026.pdf',
      buffer: Buffer.from('%PDF-1.7'),
    } as Express.Multer.File);

    expect(url).toMatch(/-Regulamento_2026\.pdf$/);
  });

  it('foto de revistoria em base64 só mantém extensão de imagem', async () => {
    jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);

    const imagem = await service.uploadReinspectionPhotoFromBase64(
      'data:image/jpeg;base64,/9j/4AAQ',
      'frente.jpg',
    );
    const ativo = await service.uploadReinspectionPhotoFromBase64(
      'PGh0bWw+',
      'frente.html',
    );

    expect(imagem).toMatch(/-frente\.jpg$/);
    expect(ativo).toMatch(/-frente\.bin$/);
  });
});

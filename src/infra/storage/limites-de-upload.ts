import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

const MB = 1024 * 1024;

/**
 * Tetos de upload por tipo de arquivo. Sem `limits`, o multer aceita arquivo
 * de qualquer tamanho e o guarda inteiro na memória do processo.
 *
 * Ficam abaixo do `client_max_body_size` de 25 MB que o Nginx aplica às
 * rotas de upload (ops/nginx/beneficios-api.conf): a aplicação responde com
 * 413 e mensagem antes de o proxy cortar a conexão.
 */
export const LIMITE_IMAGEM: MulterOptions = {
  limits: { fileSize: 15 * MB, files: 4 },
};

export const LIMITE_DOCUMENTO: MulterOptions = {
  limits: { fileSize: 20 * MB, files: 1 },
};

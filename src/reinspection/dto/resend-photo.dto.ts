import { IsString } from 'class-validator';

export class ResendPhotoDto {
  /** Imagem comprimida pelo app e convertida para base64. */
  @IsString()
  base64: string;
}

import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AddPhotoItemDto {
  @IsString()
  @MaxLength(255)
  nomeArquivo: string;

  @IsOptional()
  @IsInt()
  codigoTipo?: number;

  /** ID do template correspondente a esta foto (usado no fluxo de reenvio). */
  @IsOptional()
  @IsInt()
  templatePhotoId?: number;

  /** Imagem comprimida pelo app e convertida para base64. */
  @IsString()
  binario: string;
}

export class AddPhotosDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AddPhotoItemDto)
  photos: AddPhotoItemDto[];
}

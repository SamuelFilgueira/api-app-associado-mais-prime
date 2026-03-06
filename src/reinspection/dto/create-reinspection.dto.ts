import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum ReinspectionVehicleType {
  VEICULOS_LEVES = 'VEICULOS_LEVES',
  MOTOS = 'MOTOS',
  CAMINHOES = 'CAMINHOES',
}

export class ReinspectionPhotoDto {
  @IsString()
  @MaxLength(255)
  nomeArquivo: string;

  @IsOptional()
  @IsInt()
  codigoTipo?: number;

  /** Imagem comprimida pelo app e convertida para base64. */
  @IsString()
  binario: string;
}

export class CreateReinspectionDto {
  @IsInt()
  userVehicleId: number;

  @IsEnum(ReinspectionVehicleType)
  vehicleType: ReinspectionVehicleType;

  /** Código do veículo no SGA (opcional — usado na chamada à Hinova). */
  @IsOptional()
  @IsInt()
  codigoVeiculo?: number;

  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReinspectionPhotoDto)
  photos: ReinspectionPhotoDto[];
}

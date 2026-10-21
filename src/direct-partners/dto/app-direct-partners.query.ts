import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DirectPartnerCategory } from 'src/direct-partners/enums/direct-partner.enums';

/** Posição do associado (opcional) — habilita `distanciaKm`. */
export class AppDirectPartnerCoordsQuery {
  @ApiPropertyOptional({ example: -8.1189 })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: -34.8993 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;
}

/** Query da listagem do app (§6.1). */
export class AppDirectPartnersQuery extends AppDirectPartnerCoordsQuery {
  @ApiPropertyOptional({ enum: DirectPartnerCategory })
  @IsOptional()
  @IsEnum(DirectPartnerCategory)
  categoria?: DirectPartnerCategory;

  @ApiPropertyOptional({
    description: 'Parceiros vinculados a essa categoria Alloyal na base do JWT',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  alloyalCategoryId?: number;

  @ApiPropertyOptional({ minLength: 2 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  busca?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsBooleanString()
  destaque?: string;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

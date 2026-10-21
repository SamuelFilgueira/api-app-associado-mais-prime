import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';
import { DirectPartnerCategory } from 'src/direct-partners/enums/direct-partner.enums';

export const LIST_ORDER_BY = ['name', 'createdAt', 'sortOrder'] as const;
export type ListOrderBy = (typeof LIST_ORDER_BY)[number];

/** Query da listagem do painel (§5.1). */
export class ListDirectPartnersQuery {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ description: 'Busca em nome, bairro e cidade' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ enum: DirectPartnerCategory })
  @IsOptional()
  @IsEnum(DirectPartnerCategory)
  category?: DirectPartnerCategory;

  @ApiPropertyOptional({ description: 'Só parceiros publicados nessa base' })
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsBooleanString()
  featured?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], default: 'false' })
  @IsOptional()
  @IsBooleanString()
  includeDeleted?: string;

  @ApiPropertyOptional({ enum: LIST_ORDER_BY, default: 'sortOrder' })
  @IsOptional()
  @IsIn(LIST_ORDER_BY)
  orderBy: ListOrderBy = 'sortOrder';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'asc';
}

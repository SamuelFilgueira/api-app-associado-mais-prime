import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';

/** Query da lista de resgates de um cupom no painel (§5.8). */
export class ListRedemptionsQuery {
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

  @ApiPropertyOptional({ description: 'Filtra pela base do resgate' })
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;
}

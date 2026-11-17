import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';

export class ParticiparDto {
  @ApiPropertyOptional({ default: 1, description: 'Bilhetes do sorteio' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  bilhetes?: number;
}

export class ConfirmarContatoDto {
  @ApiProperty({ example: '(21) 99999-8888' })
  @IsString()
  @MaxLength(25)
  telefone: string;
}

export class DashboardQuery {
  @ApiProperty({ example: 'MAIS_PRIME' })
  @IsTenantBase()
  baseOrigin: string;
}

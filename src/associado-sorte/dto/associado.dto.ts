import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBooleanString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';

export class BuscarAssociadosQuery extends PaginacaoQuery {
  @ApiPropertyOptional({ description: 'Nome ou CPF' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  busca?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'Filtra pela inscrição',
  })
  @IsOptional()
  @IsBooleanString()
  inscrito?: string;
}

export class AjusteCreditosDto {
  @ApiProperty({
    example: 10,
    description: 'Positivo credita, negativo debita',
  })
  @IsInt()
  @NotEquals(0)
  @Min(-1_000_000)
  @Max(1_000_000)
  valor: number;

  @ApiProperty({ example: 'Compensação por falha no sorteio' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  motivo: string;
}

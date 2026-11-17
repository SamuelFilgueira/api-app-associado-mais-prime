import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';
import {
  SorteMecanica,
  SorteModoCredito,
  SorteRodadaEstado,
} from 'src/associado-sorte/enums/associado-sorte.enums';

export class CriarRodadaDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  premioId: number;

  @ApiPropertyOptional({ description: 'Vazio: o app usa o nome do prêmio' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  titulo?: string | null;

  @ApiProperty({ enum: SorteMecanica })
  @IsEnum(SorteMecanica)
  mecanica: SorteMecanica;

  @ApiProperty({ example: 1, description: 'Unidades do prêmio em disputa' })
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantidade: number;

  @ApiProperty({ example: 5, description: 'Custo por bilhete / por resgate' })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  custoCreditos: number;

  @ApiPropertyOptional({ enum: SorteModoCredito, default: 'CONSOME' })
  @IsOptional()
  @IsEnum(SorteModoCredito)
  modoCredito?: SorteModoCredito;

  @ApiPropertyOptional({ default: 1, description: 'Só SORTEIO' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  bilhetesMaximos?: number;

  @ApiProperty({ example: '2026-11-20T20:00:00-03:00' })
  @IsISO8601({ strict: true })
  abertura: string;

  @ApiProperty({ example: '2026-11-20T21:00:00-03:00' })
  @IsISO8601({ strict: true })
  encerramento: string;

  /** Validadas no serviço para devolver 422 `BASE_INVALIDA`. */
  @ApiProperty({ type: [String], example: ['MAIS_PRIME'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  baseOrigins: string[];
}

export class AtualizarRodadaDto extends PartialType(CriarRodadaDto) {}

export class DuplicarRodadaDto {
  @ApiProperty({
    example: 4,
    description: 'Cria N rascunhos, um por semana a partir da rodada',
  })
  @IsInt()
  @Min(1)
  @Max(26)
  semanas: number;
}

export class ListarRodadasQuery {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  // Teto maior que o das outras listas: a visão semanal do painel busca a
  // semana inteira de uma vez.
  @ApiPropertyOptional({ default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 20;

  @ApiPropertyOptional({ description: 'Abertura a partir de (ISO)' })
  @IsOptional()
  @IsISO8601()
  de?: string;

  @ApiPropertyOptional({ description: 'Abertura até (ISO, exclusivo)' })
  @IsOptional()
  @IsISO8601()
  ate?: string;

  @ApiPropertyOptional({ enum: SorteRodadaEstado })
  @IsOptional()
  @IsEnum(SorteRodadaEstado)
  estado?: SorteRodadaEstado;

  @ApiPropertyOptional({ enum: SorteMecanica })
  @IsOptional()
  @IsEnum(SorteMecanica)
  mecanica?: SorteMecanica;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  premioId?: number;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'desc';
}

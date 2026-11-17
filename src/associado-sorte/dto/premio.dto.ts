import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsBooleanString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import { SorteProdutoTipo } from 'src/associado-sorte/enums/associado-sorte.enums';

export class CriarPremioDto {
  @ApiProperty({ example: 'Kit churrasco' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descricao?: string | null;

  @ApiPropertyOptional({ example: 149.9, description: 'Valor estimado em R$' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999)
  valorEstimado?: number | null;

  @ApiPropertyOptional({
    default: 0,
    description: 'Estoque inicial (gera movimento ENTRADA)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  estoqueInicial?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  // ------------------------------------------------------- Loja da Sorte (v2)

  @ApiPropertyOptional({ enum: SorteProdutoTipo, default: 'FISICO' })
  @IsOptional()
  @IsEnum(SorteProdutoTipo)
  tipo?: SorteProdutoTipo;

  @ApiPropertyOptional({
    example: 120,
    description: 'Preço em créditos (≥ 1 para ficar na loja)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  custoCreditos?: number;

  @ApiPropertyOptional({
    default: false,
    description: 'Aparece na Loja da Sorte',
  })
  @IsOptional()
  @IsBoolean()
  naLoja?: boolean;

  @ApiPropertyOptional({
    default: 0,
    description: 'Compras por associado (0 = sem limite)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  limitePorAssociado?: number;

  @ApiPropertyOptional({
    example: 'Apresente o código do pedido na Pagé Amortecedores.',
    description: 'Texto mostrado ao associado depois da compra',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instrucoesRetirada?: string | null;

  @ApiPropertyOptional({
    default: 0,
    description: 'Ordem na vitrine (menor primeiro)',
  })
  @IsOptional()
  @IsInt()
  @Min(-100_000)
  @Max(100_000)
  ordem?: number;
}

/** O estoque só muda por `POST :id/estoque` (com motivo e histórico). */
export class AtualizarPremioDto extends PartialType(CriarPremioDto) {}

export const MOVIMENTO_MANUAL = ['ENTRADA', 'AJUSTE'] as const;
export type MovimentoManual = (typeof MOVIMENTO_MANUAL)[number];

export class MovimentarEstoqueDto {
  @ApiProperty({ enum: MOVIMENTO_MANUAL })
  @IsIn(MOVIMENTO_MANUAL)
  tipo: MovimentoManual;

  @ApiProperty({
    example: 5,
    description: 'ENTRADA: positivo. AJUSTE: com sinal (negativo retira).',
  })
  @IsInt()
  @NotEquals(0)
  @Min(-1_000_000)
  @Max(1_000_000)
  quantidade: number;

  @ApiProperty({ example: 'Compra de reposição' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  motivo: string;
}

export class ListarPremiosQuery extends PaginacaoQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  busca?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsBooleanString()
  ativo?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsBooleanString()
  naLoja?: string;

  @ApiPropertyOptional({ enum: SorteProdutoTipo })
  @IsOptional()
  @IsEnum(SorteProdutoTipo)
  tipo?: SorteProdutoTipo;
}

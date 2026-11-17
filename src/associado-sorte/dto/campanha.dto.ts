import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBase64,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import { SorteCampanhaEstado } from 'src/associado-sorte/enums/associado-sorte.enums';

export class CriarCampanhaDto {
  @ApiProperty({ example: 'MAIS_PRIME' })
  @IsTenantBase()
  baseOrigin: string;

  @ApiProperty({ example: 'Associado da Sorte 2027' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome: string;

  @ApiProperty({ example: '2027-01-01T00:00:00-03:00' })
  @IsISO8601()
  inicio: string;

  @ApiProperty({ example: '2027-12-31T23:59:59-03:00' })
  @IsISO8601()
  fim: string;
}

/** Depois de publicada, só `nome` muda (o resto responde CAMPANHA_TRAVADA). */
export class AtualizarCampanhaDto extends PartialType(CriarCampanhaDto) {}

export class ListarCampanhasQuery extends PaginacaoQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;

  @ApiPropertyOptional({ enum: SorteCampanhaEstado })
  @IsOptional()
  @IsIn(Object.values(SorteCampanhaEstado))
  estado?: SorteCampanhaEstado;
}

export class ImportarCronogramaDto {
  @ApiPropertyOptional({
    description:
      'Conteúdo do CSV (Dia;Horário;Prêmio ou data;hora;creditos;descricao). Separador ; ou , e cabeçalho em qualquer ordem. Informe `csv` ou `xlsxBase64`.',
    example: 'Dia;Horário;Prêmio\n14/12/2026;09:40:31;Voucher R$120',
  })
  @ValidateIf((o: ImportarCronogramaDto) => !o.xlsxBase64)
  @IsString()
  @IsNotEmpty({ message: 'Envie o CSV ou a planilha .xlsx' })
  @MaxLength(5_000_000)
  csv?: string;

  @ApiPropertyOptional({
    description:
      'Planilha oficial (.xlsx) em base64: aba Cronograma (Dia | Horário | Prêmio) e, opcional, aba Resumo para conferência.',
  })
  @IsOptional()
  @IsBase64()
  @MaxLength(14_000_000)
  xlsxBase64?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'true: o arquivo substitui todos os momentos do rascunho. false: acrescenta.',
  })
  @IsOptional()
  @IsBoolean()
  substituir?: boolean;
}

export class MomentoDto {
  @ApiProperty({ example: '2026-11-20T15:00:00-03:00' })
  @IsISO8601()
  liberaEm: string;

  @ApiProperty({ example: 120 })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  creditos: number;

  @ApiPropertyOptional({ example: 'Voucher da tarde' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  descricao?: string | null;
}

export class AtualizarMomentoDto extends PartialType(MomentoDto) {}

export class ListarMomentosQuery {
  @ApiPropertyOptional({ enum: ['AGUARDANDO', 'DISPONIVEL', 'GANHO'] })
  @IsOptional()
  @IsIn(['AGUARDANDO', 'DISPONIVEL', 'GANHO'])
  status?: 'AGUARDANDO' | 'DISPONIVEL' | 'GANHO';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 100, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 100;
}

export class PublicarCampanhaDto {
  @ApiProperty({
    description: 'Nome da campanha digitado pelo operador (confirmação)',
  })
  @IsString()
  @MaxLength(120)
  confirmacao: string;
}

export class EncerrarCampanhaDto {
  @ApiProperty({ example: 'Encerramento antecipado pedido pela diretoria' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  motivo: string;
}

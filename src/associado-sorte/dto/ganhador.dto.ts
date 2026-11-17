import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import {
  SorteGanhadorOrigem,
  SorteGanhadorSituacao,
} from 'src/associado-sorte/enums/associado-sorte.enums';

export class ListarGanhadoresQuery extends PaginacaoQuery {
  @ApiPropertyOptional({ enum: SorteGanhadorSituacao })
  @IsOptional()
  @IsEnum(SorteGanhadorSituacao)
  situacao?: SorteGanhadorSituacao;

  @ApiPropertyOptional({ enum: SorteGanhadorOrigem })
  @IsOptional()
  @IsEnum(SorteGanhadorOrigem)
  origem?: SorteGanhadorOrigem;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  rodadaId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;

  @ApiPropertyOptional({ description: 'Ganhou a partir de (ISO)' })
  @IsOptional()
  @IsISO8601()
  de?: string;

  @ApiPropertyOptional({ description: 'Ganhou até (ISO, exclusivo)' })
  @IsOptional()
  @IsISO8601()
  ate?: string;

  @ApiPropertyOptional({ description: 'Código do prêmio ou nome do associado' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  busca?: string;
}

export class AtualizarGanhadorDto {
  @ApiPropertyOptional({ enum: SorteGanhadorSituacao })
  @IsOptional()
  @IsEnum(SorteGanhadorSituacao)
  situacao?: SorteGanhadorSituacao;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observacao?: string | null;

  @ApiPropertyOptional({
    description: 'Só ao cancelar: devolve a unidade ao estoque do prêmio',
  })
  @IsOptional()
  @IsBoolean()
  devolverAoEstoque?: boolean;

  @ApiPropertyOptional({
    description: 'Só ao cancelar: devolve os créditos gastos (ESTORNO)',
  })
  @IsOptional()
  @IsBoolean()
  estornarCreditos?: boolean;
}

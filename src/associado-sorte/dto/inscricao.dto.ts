import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsBooleanString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import { SorteInscricaoFonte } from 'src/associado-sorte/enums/associado-sorte.enums';

export class ListarInscricoesQuery extends PaginacaoQuery {
  @ApiPropertyOptional({ description: 'Nome ou CPF' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  busca?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsBooleanString()
  inscrito?: string;

  @ApiPropertyOptional({ enum: SorteInscricaoFonte })
  @IsOptional()
  @IsEnum(SorteInscricaoFonte)
  fonte?: SorteInscricaoFonte;
}

export class MarcarInscricaoDto {
  @ApiProperty({ description: 'true = inscrito, false = não inscrito' })
  @IsBoolean()
  inscrito: boolean;

  @ApiPropertyOptional({ example: 'Contrato assinado na loja' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  motivo?: string;
}

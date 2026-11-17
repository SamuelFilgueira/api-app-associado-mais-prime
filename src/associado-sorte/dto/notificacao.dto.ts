import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBooleanString, IsEnum, IsOptional } from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import { SorteNotificacaoAdminTipo } from 'src/associado-sorte/enums/associado-sorte.enums';

export class ListarNotificacoesQuery extends PaginacaoQuery {
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsBooleanString()
  lida?: string;

  @ApiPropertyOptional({ enum: SorteNotificacaoAdminTipo })
  @IsOptional()
  @IsEnum(SorteNotificacaoAdminTipo)
  tipo?: SorteNotificacaoAdminTipo;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;
}

export class BaseOpcionalQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsTenantBase()
  baseOrigin?: string;
}

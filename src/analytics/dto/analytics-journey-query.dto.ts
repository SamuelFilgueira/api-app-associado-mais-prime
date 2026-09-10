import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Filtros das consultas de jornada (endpoints admin). */
export class AnalyticsJourneyQueryDto {
  /** Início do intervalo (ISO). Default: 7 dias atrás. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Fim do intervalo (ISO). Default: agora. */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** Filtra pelo aparelho (installHash completo ou prefixo ≥ 8 caracteres). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  install?: string;

  /** Filtra por nome de tela/ação/formulário (ex.: screen_rastreamento). */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  event?: string;

  /** Tamanho da página (1–1000). Default: 200. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  /** Cursor (id do último evento da página anterior) para paginação estável. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cursor?: number;
}

/** Filtros da listagem de aparelhos de uma conta. */
export class AnalyticsJourneyDevicesQueryDto {
  /**
   * Janela (dias) para considerar o vínculo "ativo": aparelho enviou summary
   * autenticado dentro do prazo e sem logout posterior. Default: 30.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  active_days?: number;
}

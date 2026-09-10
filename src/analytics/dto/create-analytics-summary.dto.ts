import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  JOURNEY_EVENT_TYPES,
  JOURNEY_FORM_OUTCOMES,
  MAX_JOURNEY_EVENTS,
} from 'src/analytics/constants/analytics-journey.constants';

export class AnalyticsAppInfoDto {
  @IsEnum(['ios', 'android'])
  platform: 'ios' | 'android';

  @IsString()
  @MaxLength(20)
  version: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  runtime_version?: string;
}

export class AnalyticsSessionInfoDto {
  @IsUUID('4')
  session_id: string;

  @IsUUID('4')
  anonymous_install_id: string;
}

export class AnalyticsScreenSummaryDto {
  @IsString()
  screen: string;

  @IsInt()
  @Min(0)
  view_count: number;

  @IsInt()
  @Min(0)
  total_time_ms: number;
}

export class AnalyticsActionSummaryDto {
  @IsString()
  action: string;

  @IsInt()
  @Min(0)
  count: number;
}

export class AnalyticsFormSummaryDto {
  @IsString()
  screen: string;

  @IsString()
  form: string;

  @IsInt()
  @Min(0)
  started_count: number;

  @IsInt()
  @Min(0)
  submitted_count: number;

  @IsInt()
  @Min(0)
  success_count: number;

  @IsInt()
  @Min(0)
  error_count: number;
}

/**
 * Bloco OPCIONAL com dados do aparelho (expo-device). Só é persistido quando
 * ANALYTICS_JOURNEY_ENABLED=true. Apps antigos que não enviam continuam válidos.
 * Não aceitar nome do aparelho definido pelo usuário ("iPhone do Fulano") —
 * é dado pessoal e não ajuda a identificar o modelo.
 */
export class AnalyticsDeviceInfoDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  model?: string;

  /** Identificador do modelo (ex.: "iPhone14,2" ou codename Android). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  model_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  os_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  os_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  device_type?: string;

  /** Fuso do aparelho (ex.: "America/Sao_Paulo"). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;
}

/**
 * Um evento ordenado da jornada. `t` é o horário no aparelho (ISO 8601).
 * `event` precisa estar na allowlist correspondente ao `type`
 * (screens, actions ou forms) — caso contrário é descartado silenciosamente.
 */
export class AnalyticsJourneyEventDto {
  @IsDateString()
  t: string;

  @IsEnum(JOURNEY_EVENT_TYPES)
  type: 'screen' | 'action' | 'form';

  @IsString()
  @MaxLength(80)
  event: string;

  /** Somente type=screen: tempo de permanência na tela. */
  @IsOptional()
  @IsInt()
  @Min(0)
  duration_ms?: number;

  /** Somente type=form: tela em que o formulário foi exibido. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  screen?: string;

  /** Somente type=form. */
  @IsOptional()
  @IsEnum(JOURNEY_FORM_OUTCOMES)
  outcome?: 'started' | 'submitted' | 'success' | 'error';
}

export class CreateAnalyticsSummaryDto {
  @IsDateString()
  period_start: string;

  @IsDateString()
  period_end: string;

  @ValidateNested()
  @Type(() => AnalyticsAppInfoDto)
  app: AnalyticsAppInfoDto;

  @ValidateNested()
  @Type(() => AnalyticsSessionInfoDto)
  session: AnalyticsSessionInfoDto;

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => AnalyticsScreenSummaryDto)
  screens: AnalyticsScreenSummaryDto[];

  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => AnalyticsActionSummaryDto)
  actions: AnalyticsActionSummaryDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AnalyticsFormSummaryDto)
  forms?: AnalyticsFormSummaryDto[];

  // ── Campos aditivos (jornada) — opcionais, contrato antigo permanece válido ──

  @IsOptional()
  @ValidateNested()
  @Type(() => AnalyticsDeviceInfoDto)
  device?: AnalyticsDeviceInfoDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_JOURNEY_EVENTS)
  @ValidateNested({ each: true })
  @Type(() => AnalyticsJourneyEventDto)
  journey?: AnalyticsJourneyEventDto[];
}

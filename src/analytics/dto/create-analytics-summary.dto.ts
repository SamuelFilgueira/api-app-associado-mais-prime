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
}

import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

export class AnalyticsDashboardQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsEnum(['ios', 'android'])
  platform?: 'ios' | 'android';

  @IsOptional()
  @IsString()
  app_version?: string;
}

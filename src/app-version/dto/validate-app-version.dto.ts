import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ValidateAppVersionDto {
  @IsEnum(['android', 'ios'])
  platform: 'android' | 'ios';

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  runtimeVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  buildNumber?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  versionCode?: number;
}

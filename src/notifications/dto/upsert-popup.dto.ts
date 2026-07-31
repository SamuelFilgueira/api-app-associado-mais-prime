import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpsertPopupDto {
  @IsString()
  @IsOptional()
  imageUrl?: string;

  @IsString()
  @IsOptional()
  linkUrl?: string;

  @IsString()
  @IsOptional()
  linkLabel?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  )
  active?: boolean;
}

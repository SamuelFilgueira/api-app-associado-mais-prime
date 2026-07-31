import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateSliderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  subtitle?: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  imageUrl?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  whatsapp?: string;

  @IsString()
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  linkUrl?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  )
  isActive?: boolean;
}

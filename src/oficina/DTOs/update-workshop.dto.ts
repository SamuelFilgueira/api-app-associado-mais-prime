import {
  IsString,
  IsEmail,
  IsOptional,
  IsBoolean,
  MaxLength,
  IsEnum,
} from 'class-validator';
import { State } from '@prisma/client';

export class UpdateWorkshopDto {
  // Dados principais
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  shortDescription?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  phoneSecondary?: string;

  @IsOptional()
  @IsString()
  whatsapp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  // Flags
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  featuredInApp?: boolean;

  // Endereço
  @IsOptional()
  @IsString()
  cep?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @IsString()
  number?: string;

  @IsOptional()
  @IsString()
  complement?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsEnum(State)
  state?: State;

  // Fotos
  @IsOptional()
  @IsString()
  photoFrontUrl?: string;

  @IsOptional()
  @IsString()
  photoBackUrl?: string;

  @IsOptional()
  @IsString()
  mapFrameUrl?: string;
}

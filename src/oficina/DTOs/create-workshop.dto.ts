import {
  IsString,
  IsEmail,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsLatitude,
  IsLongitude,
  MaxLength,
  IsEnum,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';
import { State, WorkshopSpecialty } from '@prisma/client';

export class CreateWorkshopDto {
  // Dados principais
  @IsString()
  @MaxLength(150)
  name: string;

  @IsEmail()
  @IsOptional()
  @MaxLength(150)
  email?: string;

  @IsString()
  @MaxLength(100)
  shortDescription: string;

  @IsString()
  phone: string;

  @IsString()
  @IsOptional()
  phoneSecondary?: string;

  @IsString()
  @IsOptional()
  whatsapp?: string;

  @IsString()
  @MaxLength(400)
  description: string;

  @IsEnum(WorkshopSpecialty)
  specialty: WorkshopSpecialty;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  services?: string[];

  // Flags
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  featuredInApp?: boolean;

  // Coordenadas
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  // Endereço
  @IsString()
  cep: string;

  @IsString()
  address: string;

  @IsString()
  district: string;

  @IsString()
  number: string;

  @IsString()
  @IsOptional()
  complement?: string;

  @IsString()
  city: string;

  @IsEnum(State)
  state: State;

  @IsString()
  @IsOptional()
  mapFrameUrl?: string;

  // Fotos
  @IsString()
  @IsOptional()
  photoFrontUrl?: string;

  @IsString()
  @IsOptional()
  photoBackUrl?: string;
}

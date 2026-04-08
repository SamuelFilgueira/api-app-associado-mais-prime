import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { UserBaseOrigin } from '@prisma/client';

export class RegisterDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  cpf: string;

  @IsString()
  cep?: string;

  @IsString()
  address?: string;

  @IsString()
  plate?: string;

  @IsOptional()
  @IsBoolean()
  primeiroLogin?: boolean;

  @IsOptional()
  @IsEnum(UserBaseOrigin)
  baseOrigin?: UserBaseOrigin;
}

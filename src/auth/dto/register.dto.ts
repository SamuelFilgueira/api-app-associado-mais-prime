import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import type { BaseOrigin } from 'src/config/tenant.config';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';

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
  @IsTenantBase()
  baseOrigin?: BaseOrigin;
}

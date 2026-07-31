import { IsString, IsOptional, IsBoolean, IsArray } from 'class-validator';

/**
 * Body do PATCH /client/v2/businesses/{cnpj}/users/{cpf}
 * Referência: https://lecupon.readme.io/reference/editar-usuário
 * O CPF identifica o usuário no path, não no body.
 */
export class AlloyalUpdateUserRequestDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  cellphone?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  user_tags?: string[];
}

import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class PublicarUpdateDto {
  /** Deve ser idêntica ao `runtimeVersion` embutido no binário nativo. */
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, {
    message:
      'runtimeVersion inválida: use apenas letras, números, ".", "_" e "-"',
  })
  runtimeVersion: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  descricao?: string;
}

export class RepublicarUpdateDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  descricao?: string;
}

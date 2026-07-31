import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class PrimeiroAcessoDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(11)
  @MaxLength(14)
  cpf: string;
}

import { IsNotEmpty, IsString } from 'class-validator';

export class AlloyalLoginRequestDto {
  @IsString()
  @IsNotEmpty()
  cpf: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

export class AlloyalLoginResponseDto {
  uid: string;
  client: string;
  accessToken: string;
}

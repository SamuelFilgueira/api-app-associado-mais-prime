import { IsNotEmpty, IsString } from 'class-validator';

export class RegisterExpoTokenDto {
  @IsString()
  @IsNotEmpty()
  expoPushToken: string;
}

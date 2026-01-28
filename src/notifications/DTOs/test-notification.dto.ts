import { IsString, IsNotEmpty, IsObject, IsEnum } from 'class-validator';

export class TestNotificationDto {
  @IsString()
  @IsNotEmpty()
  expoPushToken: string;

  @IsString()
  @IsNotEmpty()
  plate: string;

  @IsEnum(['on', 'off'])
  ignition: 'on' | 'off';

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  // Flags de preferência do usuário
  ignitionOn: boolean;
  ignitionOff: boolean;
}

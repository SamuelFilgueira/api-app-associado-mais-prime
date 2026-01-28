import { IsString, IsNotEmpty, IsObject, IsEnum } from 'class-validator';

export class SendNotificationDto {
  @IsString()
  @IsNotEmpty()
  expoPushToken: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  @IsObject()
  data: {
    plate: string;
    ignition: 'on' | 'off';
  };
}

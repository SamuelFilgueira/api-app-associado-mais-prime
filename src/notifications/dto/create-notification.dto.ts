import { IsString, IsNotEmpty, IsNumber, IsObject } from 'class-validator';

export class CreateNotificationDto {
  @IsNumber()
  userId: number;

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
    [key: string]: any;
  };
}

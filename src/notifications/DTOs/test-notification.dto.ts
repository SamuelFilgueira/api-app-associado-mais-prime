import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsInt,
  IsOptional,
} from 'class-validator';

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

  @IsInt()
  @IsOptional()
  userId?: number;
}

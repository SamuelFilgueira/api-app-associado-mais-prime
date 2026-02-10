import { IsString, IsNotEmpty, IsObject, IsOptional } from 'class-validator';

export class SendMarketingNotificationDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  @IsObject()
  @IsOptional()
  data?: Record<string, any>;
}

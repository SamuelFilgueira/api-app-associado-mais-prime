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
  data?: {
    type: 'external_link' | 'internal_route' | 'campaign';
    url?: string;
    screen?: string;
    params?: Record<string, any>;
    campaignId?: string;
  };
}
import {
  IsISO8601,
  IsString,
  IsNotEmpty,
  IsObject,
  IsOptional,
} from 'class-validator';

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

  /**
   * Opcional: data/hora (ISO 8601 com fuso, ex.: `2026-12-01T09:00:00-03:00`)
   * para agendar o disparo. Ausente = envio imediato (comportamento original).
   */
  @IsISO8601({ strict: true })
  @IsOptional()
  agendarPara?: string;
}

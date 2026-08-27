import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

/**
 * DTO da rota POST /notifications/admin/situacao-cadastro.
 * A requisição é multipart/form-data (planilha + campos de texto),
 * por isso o campo `data` chega como string JSON e é parseado no serviço.
 */
export class SendSituacaoCadastroNotificationDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  /**
   * JSON opcional com payload extra da notificação, no mesmo formato
   * do campo `data` da rota de marketing. Ex.:
   * {"type":"internal_route","screen":"Boletos"}
   */
  @IsString()
  @IsOptional()
  data?: string;
}

export interface SituacaoCadastroNotificationData {
  type: string;
  url?: string;
  screen?: string;
  params?: Record<string, any>;
  campaignId?: string;
  [key: string]: any;
}

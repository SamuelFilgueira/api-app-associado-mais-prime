import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

export class DirectPartnerContactDto {
  @ApiPropertyOptional({ example: '(81) 3465-1200' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    example: '5581994651200',
    description: 'Só dígitos com DDI (12 ou 13 dígitos)',
  })
  @IsOptional()
  @Matches(/^\d{12,13}$/, {
    message: 'whatsapp deve conter só dígitos com DDI (12 a 13 dígitos)',
  })
  whatsapp?: string;

  @ApiPropertyOptional({ example: 'https://autocenterpremium.com.br' })
  @IsOptional()
  @IsUrl()
  @MaxLength(300)
  website?: string;

  @ApiPropertyOptional({ example: '@autocenterpremium' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  instagram?: string;
}

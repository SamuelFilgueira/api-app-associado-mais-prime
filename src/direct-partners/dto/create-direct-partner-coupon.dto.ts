import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateDirectPartnerCouponDto {
  @ApiProperty({
    example: 'PRIME15REV',
    description: 'Caixa alta, sem espaços; único por parceiro',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9_-]{3,40}$/, {
    message: 'code deve ter 3 a 40 caracteres (A-Z, 0-9, _ ou -)',
  })
  code: string;

  @ApiProperty({ example: '15%', description: 'Texto curto do ticket' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  highlight: string;

  @ApiProperty({ example: 'Revisão completa' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  title: string;

  @ApiProperty({
    example: '15% de desconto na revisão completa do veículo.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  description: string;

  @ApiProperty({
    type: [String],
    example: ['Válido de segunda a sexta-feira'],
    description: '1 a 10 condições, até 160 caracteres cada',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(160, { each: true })
  conditions: string[];

  @ApiPropertyOptional({ example: null, description: 'yyyy-mm-dd' })
  @IsOptional()
  @IsDateString()
  validFrom?: string | null;

  @ApiProperty({ example: '2026-12-31', description: 'yyyy-mm-dd (inclusivo)' })
  @IsDateString()
  validUntil: string;

  @ApiPropertyOptional({
    default: false,
    description: 'true: 1 resgate por associado; código só após "Resgatar"',
  })
  @IsOptional()
  @IsBoolean()
  singleUse?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

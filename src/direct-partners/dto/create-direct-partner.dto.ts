import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsTenantBase } from 'src/config/is-tenant-base.validator';
import { CreateDirectPartnerCouponDto } from 'src/direct-partners/dto/create-direct-partner-coupon.dto';
import { DirectPartnerAddressDto } from 'src/direct-partners/dto/direct-partner-address.dto';
import { DirectPartnerContactDto } from 'src/direct-partners/dto/direct-partner-contact.dto';
import { DirectPartnerOpeningHourDto } from 'src/direct-partners/dto/direct-partner-opening-hour.dto';
import {
  DirectPartnerCategory,
  DirectPartnerTone,
} from 'src/direct-partners/enums/direct-partner.enums';

export class CreateDirectPartnerDto {
  @ApiProperty({
    type: [String],
    example: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
    description: 'Bases (tenants) em que o parceiro é publicado',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsTenantBase({ each: true })
  baseOrigins: string[];

  @ApiProperty({ example: 'Auto Center Premium' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiProperty({
    example: 'Oficina completa: mecânica, elétrica e revisões com garantia.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  shortDescription: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ enum: DirectPartnerCategory })
  @IsEnum(DirectPartnerCategory)
  category: DirectPartnerCategory;

  @ApiPropertyOptional({ description: 'Rótulo exibido; nulo usa o padrão' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  categoryLabel?: string | null;

  @ApiPropertyOptional({
    example: { MAIS_PRIME: [12, 48], MAIS_PRIME_RS: [7] },
    description: 'Ids de categoria Alloyal por base',
  })
  @IsOptional()
  @IsObject()
  alloyalCategoryIds?: Record<string, number[]> | null;

  @ApiPropertyOptional({ enum: DirectPartnerTone, default: 'ACCENT' })
  @IsOptional()
  @IsEnum(DirectPartnerTone)
  tone?: DirectPartnerTone;

  @ApiProperty({ type: DirectPartnerAddressDto })
  @ValidateNested()
  @Type(() => DirectPartnerAddressDto)
  address: DirectPartnerAddressDto;

  @ApiPropertyOptional({ type: DirectPartnerContactDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DirectPartnerContactDto)
  contact?: DirectPartnerContactDto | null;

  @ApiPropertyOptional({ example: 'Seg a Sex · 08h às 18h' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  openingHoursText?: string | null;

  @ApiPropertyOptional({ type: [DirectPartnerOpeningHourDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DirectPartnerOpeningHourDto)
  openingHours?: DirectPartnerOpeningHourDto[] | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  featured?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [CreateDirectPartnerCouponDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateDirectPartnerCouponDto)
  coupons?: CreateDirectPartnerCouponDto[];
}

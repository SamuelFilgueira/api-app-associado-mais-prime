import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { DocumentType } from '@prisma/client';

export class CreateDocumentDto {
  @IsString()
  description: string;

  @IsOptional()
  @IsString()
  documentUrl?: string;

  @IsEnum(DocumentType)
  type: DocumentType;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsOptional()
  @IsBoolean()
  visibleConsultor?: boolean;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsOptional()
  @IsBoolean()
  visibleAssociado?: boolean;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsOptional()
  @IsBoolean()
  visibleBoth?: boolean;
}

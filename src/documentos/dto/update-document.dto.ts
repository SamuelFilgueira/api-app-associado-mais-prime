import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { DocumentType } from '@prisma/client';

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  documentUrl?: string;

  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;

  @IsOptional()
  @IsBoolean()
  visibleConsultor?: boolean;

  @IsOptional()
  @IsBoolean()
  visibleAssociado?: boolean;

  @IsOptional()
  @IsBoolean()
  visibleBoth?: boolean;
}

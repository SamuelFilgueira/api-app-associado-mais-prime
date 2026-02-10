import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { DocumentType } from '@prisma/client';

export class CreateDocumentDto {
  @IsString()
  description: string;

  @IsString()
  documentUrl: string;

  @IsEnum(DocumentType)
  type: DocumentType;

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

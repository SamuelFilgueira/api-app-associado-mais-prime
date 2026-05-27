import { IsBooleanString, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListReinspectionPaymentsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  nossoNumero?: string;

  @IsOptional()
  @IsString()
  situacaoBoleto?: string;

  @IsOptional()
  @IsBooleanString()
  pago?: string;

  @IsOptional()
  @IsString()
  plate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  userVehicleId?: number;
}

import { IsEnum, IsInt, IsOptional } from 'class-validator';

export enum ReinspectionVehicleType {
  VEICULOS_LEVES = 'VEICULOS_LEVES',
  MOTOS = 'MOTOS',
  CAMINHOES = 'CAMINHOES',
}

export class CreateReinspectionDto {
  @IsInt()
  userVehicleId: number;

  @IsEnum(ReinspectionVehicleType)
  vehicleType: ReinspectionVehicleType;

  /** Código do veículo no SGA (opcional — usado na chamada à Hinova). */
  @IsOptional()
  @IsInt()
  codigoVeiculo?: number;
}

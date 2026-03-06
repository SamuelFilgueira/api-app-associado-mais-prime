import { IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ReinspectionVehicleType } from './create-reinspection.dto';

export { ReinspectionVehicleType };

export class UpsertTemplatePhotoDto {
  @IsEnum(ReinspectionVehicleType)
  vehicleType: ReinspectionVehicleType;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  ordem: number;
}

import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

export class SetRevistoriaDto {
  @IsString()
  @IsNotEmpty()
  chassi: string;

  @IsBoolean()
  reinspectionRequired: boolean;
}

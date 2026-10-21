import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
} from 'class-validator';

export class ReenviarHinovaDto {
  /** Restringe o reenvio a estas fotos. Sem informar, envia as pendentes. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  photoIds?: number[];

  /** Reenvia também fotos já marcadas como inseridas na Hinova. */
  @IsOptional()
  @IsBoolean()
  forcar?: boolean;
}

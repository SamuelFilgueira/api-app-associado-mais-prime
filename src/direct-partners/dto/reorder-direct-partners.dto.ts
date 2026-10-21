import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsInt } from 'class-validator';

/** Corpo de `PATCH /admin/parceiros-diretos/ordenar` (§5.9). */
export class ReorderDirectPartnersDto {
  @ApiProperty({ type: [Number], example: [42, 17, 9] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  ids: number[];
}

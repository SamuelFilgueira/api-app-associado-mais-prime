import { IsNumber } from 'class-validator';

export class PostosRequestDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;
}

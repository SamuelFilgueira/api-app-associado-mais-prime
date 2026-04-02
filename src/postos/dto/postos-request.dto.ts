import { IsNumber, IsString } from 'class-validator';

export class PostosRequestDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsString()
  chassi: string;
}

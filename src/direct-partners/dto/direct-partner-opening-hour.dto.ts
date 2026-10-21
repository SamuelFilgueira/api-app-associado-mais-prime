import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Matches, Max, Min } from 'class-validator';

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class DirectPartnerOpeningHourDto {
  @ApiProperty({ example: 1, description: '0 = domingo ... 6 = sábado' })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday: number;

  @ApiProperty({ example: '08:00' })
  @Matches(HORA_REGEX, { message: 'opens deve ter o formato HH:mm' })
  opens: string;

  @ApiProperty({ example: '18:00' })
  @Matches(HORA_REGEX, { message: 'closes deve ter o formato HH:mm' })
  closes: string;
}

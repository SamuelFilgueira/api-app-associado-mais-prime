import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { State } from 'src/direct-partners/enums/direct-partner.enums';

export class DirectPartnerAddressDto {
  @ApiProperty({ example: 'Av. Conselheiro Aguiar' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  street: string;

  @ApiPropertyOptional({
    example: '1234',
    description: 'Opcional (s/n, quiosques)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  number?: string;

  @ApiPropertyOptional({ example: 'Sala 2' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  complement?: string;

  @ApiProperty({ example: 'Boa Viagem' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  district: string;

  @ApiProperty({ example: 'Recife' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @ApiProperty({ enum: State, example: 'PE' })
  @IsEnum(State)
  state: State;

  @ApiProperty({ example: '51021-020' })
  @Matches(/^\d{5}-?\d{3}$/, { message: 'CEP deve ter o formato 00000-000' })
  zipCode: string;

  @ApiPropertyOptional({ example: 'Próximo ao Parque Dona Lindu' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  reference?: string;

  @ApiProperty({ example: -8.1189 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: -34.8993 })
  @IsLongitude()
  longitude: number;
}

import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, Matches } from 'class-validator';
import { CHASSI_REGEX } from 'src/sga/domain/parametros-sga';

export class SetRevistoriaDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @Matches(CHASSI_REGEX, {
    message: 'chassi inválido: use de 6 a 20 letras e números',
  })
  chassi: string;

  @IsBoolean()
  reinspectionRequired: boolean;
}

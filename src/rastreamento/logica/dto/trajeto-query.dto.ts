import {
  IsDateString,
  IsNotEmpty,
  IsString,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const MAX_PERIOD_DAYS = 31;

@ValidatorConstraint({ name: 'dataFinalGteDataInicialLogica', async: false })
export class DataFinalGteDataInicialLogicaConstraint
  implements ValidatorConstraintInterface
{
  validate(dataFinal: string, args: ValidationArguments): boolean {
    const obj = args.object as TrajetoQueryDto;
    if (!obj.dataInicial || !dataFinal) return true;
    return dataFinal >= obj.dataInicial;
  }

  defaultMessage(): string {
    return 'dataFinal deve ser maior ou igual a dataInicial';
  }
}

@ValidatorConstraint({ name: 'periodoMaximoLogica', async: false })
export class PeriodoMaximoLogicaConstraint
  implements ValidatorConstraintInterface
{
  validate(dataFinal: string, args: ValidationArguments): boolean {
    const obj = args.object as TrajetoQueryDto;
    if (!obj.dataInicial || !dataFinal) return true;

    const inicio = new Date(obj.dataInicial);
    const fim = new Date(dataFinal);
    const diffMs = fim.getTime() - inicio.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    return diffDays <= MAX_PERIOD_DAYS;
  }

  defaultMessage(): string {
    return `O período máximo permitido é de ${MAX_PERIOD_DAYS} dias`;
  }
}

export class TrajetoQueryDto {
  @IsString()
  @IsNotEmpty()
  chassi: string;

  @IsDateString()
  @IsNotEmpty()
  dataInicial: string;

  @IsDateString()
  @IsNotEmpty()
  @Validate(DataFinalGteDataInicialLogicaConstraint)
  @Validate(PeriodoMaximoLogicaConstraint)
  dataFinal: string;
}

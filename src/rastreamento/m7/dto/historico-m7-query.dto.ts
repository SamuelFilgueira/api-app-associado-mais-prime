import {
  IsDateString,
  IsNotEmpty,
  IsString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

const MAX_PERIOD_DAYS = 31;
const MAX_PERIOD_DAYS_CONTESTACAO = 5;

@ValidatorConstraint({ name: 'dataFinalGteDataInicialM7', async: false })
export class DataFinalGteDataInicialM7Constraint
  implements ValidatorConstraintInterface
{
  validate(dataFinal: string, args: ValidationArguments): boolean {
    const obj = args.object as HistoricoM7QueryDto;
    if (!obj.dataInicial || !dataFinal) return true;
    return dataFinal >= obj.dataInicial;
  }

  defaultMessage(): string {
    return 'dataFinal deve ser maior ou igual a dataInicial';
  }
}

@ValidatorConstraint({ name: 'periodoMaximoM7', async: false })
export class PeriodoMaximoM7Constraint implements ValidatorConstraintInterface {
  validate(dataFinal: string, args: ValidationArguments): boolean {
    const obj = args.object as HistoricoM7QueryDto;
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

export class HistoricoM7QueryDto {
  @IsString()
  @IsNotEmpty()
  cnpj: string;

  @IsString()
  @IsNotEmpty()
  chassi: string;

  @IsDateString()
  @IsNotEmpty()
  dataInicial: string;

  @IsDateString()
  @IsNotEmpty()
  @Validate(DataFinalGteDataInicialM7Constraint)
  @Validate(PeriodoMaximoM7Constraint)
  dataFinal: string;
}

@ValidatorConstraint({ name: 'dataFinalGteDataInicialM7Contestacao', async: false })
export class DataFinalGteDataInicialM7ContestacaoConstraint
  implements ValidatorConstraintInterface
{
  validate(dataFinal: string, args: ValidationArguments): boolean {
    const obj = args.object as HistoricoM7ContestacaoQueryDto;
    if (!obj.dataInicial || !dataFinal) return true;
    return dataFinal >= obj.dataInicial;
  }

  defaultMessage(): string {
    return 'dataFinal deve ser maior ou igual a dataInicial';
  }
}

@ValidatorConstraint({ name: 'periodoMaximoM7Contestacao', async: false })
export class PeriodoMaximoM7ContestacaoConstraint
  implements ValidatorConstraintInterface
{
  validate(dataFinal: string, args: ValidationArguments): boolean {
    const obj = args.object as HistoricoM7ContestacaoQueryDto;
    if (!obj.dataInicial || !dataFinal) return true;

    const inicio = new Date(obj.dataInicial);
    const fim = new Date(dataFinal);
    const diffMs = fim.getTime() - inicio.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    return diffDays <= MAX_PERIOD_DAYS_CONTESTACAO;
  }

  defaultMessage(): string {
    return `O período máximo permitido é de ${MAX_PERIOD_DAYS_CONTESTACAO} dias`;
  }
}

export class HistoricoM7ContestacaoQueryDto {
  @IsString()
  @IsNotEmpty()
  cnpj: string;

  @IsString()
  @IsNotEmpty()
  chassi: string;

  @IsDateString()
  @IsNotEmpty()
  dataInicial: string;

  @IsDateString()
  @IsNotEmpty()
  @Validate(DataFinalGteDataInicialM7ContestacaoConstraint)
  @Validate(PeriodoMaximoM7ContestacaoConstraint)
  dataFinal: string;
}

import {
  IsDateString,
  IsNotEmpty,
  IsString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/** Período máximo permitido em dias */
const MAX_PERIOD_DAYS = 31;

@ValidatorConstraint({ name: 'dataFinalGteDataInicial', async: false })
export class DataFinalGteDataInicialConstraint
  implements ValidatorConstraintInterface
{
  validate(dataFinal: string, args: ValidationArguments): boolean {
    const obj = args.object as HistoricoQueryDto;
    if (!obj.dataInicial || !dataFinal) return true;
    return dataFinal >= obj.dataInicial;
  }

  defaultMessage(): string {
    return 'dataFinal deve ser maior ou igual a dataInicial';
  }
}

@ValidatorConstraint({ name: 'periodoMaximo', async: false })
export class PeriodoMaximoConstraint implements ValidatorConstraintInterface {
  validate(dataFinal: string, args: ValidationArguments): boolean {
    const obj = args.object as HistoricoQueryDto;
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

/**
 * DTO de query params para os endpoints de histórico de trajetórias Softruck.
 *
 * Exemplo de uso:
 * GET /rastreamento/historico/softruck/pdf?chassi=XXXX&dataInicial=2026-05-01&dataFinal=2026-05-15
 */
export class HistoricoQueryDto {
  @IsString()
  @IsNotEmpty()
  chassi: string;

  /** Data inicial no formato ISO: YYYY-MM-DD */
  @IsDateString()
  @IsNotEmpty()
  dataInicial: string;

  /** Data final no formato ISO: YYYY-MM-DD */
  @IsDateString()
  @IsNotEmpty()
  @Validate(DataFinalGteDataInicialConstraint)
  @Validate(PeriodoMaximoConstraint)
  dataFinal: string;
}

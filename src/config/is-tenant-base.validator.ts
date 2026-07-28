import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isTenantBase, TENANT } from './tenant.config';

/**
 * Valida se o valor é uma base de origem configurada neste deploy.
 *
 * Substitui `@IsEnum(UserBaseOrigin)`, que dependia do enum do Prisma e
 * portanto exigia migration a cada nova empresa. A validação ocorre em
 * tempo de requisição (não de import), então respeita o `.env` carregado.
 */
@ValidatorConstraint({ name: 'isTenantBase', async: false })
export class IsTenantBaseConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isTenantBase(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} deve ser uma das bases configuradas: ${TENANT.baseNames.join(', ')}`;
  }
}

export function IsTenantBase(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsTenantBaseConstraint,
    });
  };
}

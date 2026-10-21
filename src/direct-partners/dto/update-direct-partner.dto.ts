import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateDirectPartnerDto } from 'src/direct-partners/dto/create-direct-partner.dto';

/**
 * Todos os campos opcionais. `baseOrigins`, `address`, `contact`,
 * `openingHours` e `alloyalCategoryIds`, quando enviados, substituem o
 * bloco inteiro. Cupons são geridos pelas rotas próprias (§5.8).
 */
export class UpdateDirectPartnerDto extends PartialType(
  OmitType(CreateDirectPartnerDto, ['coupons'] as const),
) {}

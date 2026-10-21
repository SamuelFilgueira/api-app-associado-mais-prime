import { PartialType } from '@nestjs/swagger';
import { CreateDirectPartnerCouponDto } from 'src/direct-partners/dto/create-direct-partner-coupon.dto';

export class UpdateDirectPartnerCouponDto extends PartialType(
  CreateDirectPartnerCouponDto,
) {}

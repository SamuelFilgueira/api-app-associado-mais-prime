export class AlloyalCouponRedeemRequestDto {
  coupon_id: number;
}

export class AlloyalCouponRedeemResponseDto {
  id: number;
  number: string;
  created_at: string;
  organization_name: string;
  title: string;
  description: string;
  discount: string;
  coupon_description: string;
  coupon_discount: string;
  paid_at: string | null;
  usage_ended_at: string | null;
  redeem_instruction: string | null;
  organization_cover_picture: string;
  price: number;
  redeem_code?: string;
  coupon_number?: string;
}

export class AlloyalCouponOrderResponseDto {
  id: number;
  number: string;
  created_at: string;
  coupon_description: string;
  coupon_discount: string;
  coupon_number: string | null;
  organization_name: string;
}

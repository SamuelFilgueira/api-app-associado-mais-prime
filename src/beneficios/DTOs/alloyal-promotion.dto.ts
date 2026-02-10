export class AlloyalPromotionWorkingDayDto {
  week_day: number;
  is_available: boolean;
  start_hour: string;
  end_hour: string;
}

export class AlloyalPromotionDto {
  id: number;
  title: string;
  rules: string;
  description: string;
  url: string | null;
  discount: number;
  start_date: string; // Normalizado pt-BR
  end_date: string;   // Normalizado pt-BR
  working_days: AlloyalPromotionWorkingDayDto[];
  quantity: number;
  redeemed_count: number;
  infinity: boolean;
  organization_id: number;
  dynamic_voucher: boolean;
  branch_id: number;
  coupon_id: number;
  tags: string[];
}

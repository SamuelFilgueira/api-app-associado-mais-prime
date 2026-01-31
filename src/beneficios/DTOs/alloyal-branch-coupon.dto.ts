export class AlloyalBranchCouponDto {
  id: number;
  template: string;
  title: string;
  description: string;
  cashback_text: string | null;
  online_payment_text: string | null;
  discount: number;
  start_date: string;
  end_date: string;
  infinity: boolean;
  picture_small_url: string;
  picture_large_url: string;
  organization_id: number;
  branch_id: number;
}

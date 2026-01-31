export class AlloyalOrganizationCouponDto {
  id: number;
  template: string;
  title: string;
  description: string;
  cashback_text: string | null;
  online_payment_text: string | null;
  discount: number;
  start_date: string;
  end_date: string;
}

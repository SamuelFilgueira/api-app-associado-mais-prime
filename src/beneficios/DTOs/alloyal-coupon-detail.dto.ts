export class AlloyalCouponDetailDto {
  id: number;
  organization_name: string;
  organization_cover_image: string;
  template: string;
  title: string;
  description: string;
  activation_url: string;
  rules: string;
  cashback_text: string;
  discount: number;
  start_date: string;
  end_date: string;
  code: string;
  picture_small_url: string;
  picture_large_url: string;
  working_days: Array<{
    week_day: number;
    is_available: boolean;
    start_hour: string;
    end_hour: string;
  }>;
}

export class AlloyalUserWalletDto {
  id: string;
  balance: number;
}

export class AlloyalUserTagDto {
  name: string;
  slug: string;
}

export class AlloyalUserDto {
  id: number;
  activated_at: string;
  active: boolean;
  business_id: number;
  cellphone: string;
  cpf: string;
  custom_field_1: string | null;
  custom_field_2: string | null;
  custom_field_3: string | null;
  custom_field_4: string | null;
  custom_field_5: string | null;
  custom_field_6: string | null;
  custom_field_7: string | null;
  custom_field_8: string | null;
  default_auth_flow: boolean;
  email: string;
  name: string;
  tags: string[];
  telemedicine: boolean;
  user_tags: AlloyalUserTagDto[];
  wallet: AlloyalUserWalletDto;
}

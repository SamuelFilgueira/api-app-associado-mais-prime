import type { AlloyalBranchCouponDto } from 'src/beneficios/dto/alloyal-branch-coupon.dto';
import type { AlloyalCouponDetailDto } from 'src/beneficios/dto/alloyal-coupon-detail.dto';
import type { AlloyalOrganizationCouponDto } from 'src/beneficios/dto/alloyal-organization-coupon.dto';
import { dataLocal } from 'src/beneficios/domain/alloyal-datas';

/**
 * Mapeamento dos cupons da Alloyal para os DTOs do app (funções puras).
 * As datas saem como `dd/mm/aaaa`; a ordem dos campos é a de sempre.
 */
type Bruto = Record<string, unknown>;

/** Cupom na listagem da organização. */
export function mapearCupomDaOrganizacao(
  cupom: Bruto,
  fuso?: string,
): AlloyalOrganizationCouponDto {
  return {
    id: cupom.id,
    template: cupom.template,
    title: cupom.title,
    description: cupom.description,
    cashback_text: cupom.cashback_text,
    online_payment_text: cupom.online_payment_text,
    discount: cupom.discount,
    start_date: dataLocal(cupom.start_date as string, fuso),
    end_date: dataLocal(cupom.end_date as string, fuso),
  } as AlloyalOrganizationCouponDto;
}

/** Cupom na listagem da filial: o da organização mais imagens e vínculos. */
export function mapearCupomDaFilial(
  cupom: Bruto,
  fuso?: string,
): AlloyalBranchCouponDto {
  return {
    ...mapearCupomDaOrganizacao(cupom, fuso),
    infinity: cupom.infinity,
    picture_small_url: cupom.picture_small_url,
    picture_large_url: cupom.picture_large_url,
    organization_id: cupom.organization_id,
    branch_id: cupom.branch_id,
  } as AlloyalBranchCouponDto;
}

/**
 * Detalhe do cupom. `activation_url` preenchida = cupom de loja online;
 * vazia = uso em loja física, com o código em `code`.
 */
export function mapearDetalheDoCupom(
  cupom: Bruto,
  fuso?: string,
): AlloyalCouponDetailDto {
  return {
    id: cupom.id,
    organization_name: cupom.organization_name,
    organization_cover_image: cupom.organization_cover_image,
    template: cupom.template,
    title: cupom.title,
    description: cupom.description,
    activation_url: cupom.activation_url,
    rules: cupom.rules,
    cashback_text: cupom.cashback_text,
    discount: cupom.discount,
    start_date: dataLocal(cupom.start_date as string, fuso),
    end_date: dataLocal(cupom.end_date as string, fuso),
    code: cupom.code,
    picture_small_url: cupom.picture_small_url,
    picture_large_url: cupom.picture_large_url,
    working_days: cupom.working_days,
  } as AlloyalCouponDetailDto;
}

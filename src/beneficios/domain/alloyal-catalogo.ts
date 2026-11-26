import type { AlloyalBranchDto } from 'src/beneficios/dto/alloyal-branch.dto';
import type { AlloyalOrganizationCategoryDto } from 'src/beneficios/dto/alloyal-organization.dto';
import type { AlloyalOrganizationHighlightOnlineDto } from 'src/beneficios/dto/alloyal-organization-highlight-online.dto';
import type { AlloyalOrganizationListDto } from 'src/beneficios/dto/alloyal-organization-list.dto';
import type {
  AlloyalPromotionDto,
  AlloyalPromotionWorkingDayDto,
} from 'src/beneficios/dto/alloyal-promotion.dto';
import {
  dataHoraLocal,
  horaMinutoLocal,
} from 'src/beneficios/domain/alloyal-datas';

/**
 * Mapeamento das respostas de catálogo da Alloyal (organizações, filiais e
 * promoções) para os DTOs do app. Funções puras: o que entra é o item como a
 * Alloyal devolveu, o que sai é exatamente o que o app sempre recebeu —
 * inclusive a ORDEM dos campos, que define os bytes do JSON.
 */
type Bruto = Record<string, unknown>;

/** Distância em km com duas casas; `0` quando a Alloyal não informa. */
export function arredondarDistancia(valor: unknown): number {
  return valor ? Math.round(Number(valor) * 100) / 100 : 0;
}

const CAMPOS_DA_ORGANIZACAO = [
  'id',
  'name',
  'cover_picture',
  'background_picture',
  'best_discount_percent',
  'category_name',
  'instagram_url',
  'facebook_url',
  'twitter_url',
  'cashback_percent',
  'cashback_text',
  'discount_text',
  'description',
] as const;

/**
 * Organização das listagens (`/organizations`, `nearest`, `highlights_*`):
 * só os 13 campos que o app usa, mais a distância.
 */
export function mapearOrganizacao(org: Bruto): AlloyalOrganizationListDto {
  return {
    ...mapearOrganizacaoSemDistancia(org),
    distance_km: arredondarDistancia(org.distance_km),
  } as AlloyalOrganizationListDto;
}

/** Destaques online: a mesma organização, sem o campo de distância. */
export function mapearOrganizacaoSemDistancia(
  org: Bruto,
): AlloyalOrganizationHighlightOnlineDto {
  const mapeada: Bruto = {};
  for (const campo of CAMPOS_DA_ORGANIZACAO) mapeada[campo] = org[campo];
  return mapeada as unknown as AlloyalOrganizationHighlightOnlineDto;
}

/**
 * Organização da listagem por categoria: tudo o que a Alloyal devolve
 * (inclusive `favorited`, que é do usuário), menos as redes sociais e as
 * imagens grandes; a distância é arredondada.
 */
export function mapearOrganizacaoDaCategoria(
  org: Bruto,
): AlloyalOrganizationCategoryDto {
  const {
    instagram_url: _instagram_url,
    facebook_url: _facebook_url,
    twitter_url: _twitter_url,
    top_background_image_large: _top_background_image_large,
    top_background_image_v2_large: _top_background_image_v2_large,
    banner_image_large: _banner_image_large,
    banner_image_v2_large: _banner_image_v2_large,
    ...resto
  } = org;
  return {
    ...resto,
    distance_km: arredondarDistancia(resto.distance_km),
  } as unknown as AlloyalOrganizationCategoryDto;
}

/** Filial: horários em `HH:mm` e distância arredondada. */
export function mapearFilial(filial: Bruto, fuso?: string): AlloyalBranchDto {
  return {
    id: filial.id,
    name: filial.name,
    taxpayer_number: filial.taxpayer_number,
    telephone: filial.telephone,
    full_address: filial.full_address,
    zipcode: filial.zipcode,
    lat: filial.lat,
    lng: filial.lng,
    opening_time: horaMinutoLocal(filial.opening_time as string, fuso),
    closing_time: horaMinutoLocal(filial.closing_time as string, fuso),
    distance_km: arredondarDistancia(filial.distance_km),
  } as AlloyalBranchDto;
}

function mapearDiaDeFuncionamento(dia: Bruto): AlloyalPromotionWorkingDayDto {
  return {
    week_day: dia.week_day,
    is_available: dia.is_available,
    start_hour: dia.start_hour,
    end_hour: dia.end_hour,
  } as AlloyalPromotionWorkingDayDto;
}

/** Promoção: datas em pt-BR, dias de funcionamento e tags sempre em lista. */
export function mapearPromocao(
  promo: Bruto,
  fuso?: string,
): AlloyalPromotionDto {
  return {
    id: promo.id,
    title: promo.title,
    rules: promo.rules,
    description: promo.description,
    url: promo.url,
    discount: promo.discount,
    start_date: dataHoraLocal(promo.start_date as string, fuso),
    end_date: dataHoraLocal(promo.end_date as string, fuso),
    working_days: Array.isArray(promo.working_days)
      ? (promo.working_days as Bruto[]).map(mapearDiaDeFuncionamento)
      : [],
    quantity: promo.quantity,
    redeemed_count: promo.redeemed_count,
    infinity: promo.infinity,
    organization_id: promo.organization_id,
    dynamic_voucher: promo.dynamic_voucher,
    branch_id: promo.branch_id,
    coupon_id: promo.coupon_id,
    tags: Array.isArray(promo.tags) ? (promo.tags as string[]) : [],
  } as AlloyalPromotionDto;
}

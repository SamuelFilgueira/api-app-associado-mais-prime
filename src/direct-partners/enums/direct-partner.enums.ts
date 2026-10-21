import {
  DirectPartnerCategory,
  DirectPartnerTone,
  State,
} from '@prisma/client';

export { DirectPartnerCategory, DirectPartnerTone, State };

/** Rótulo padrão exibido no app quando `categoryLabel` é nulo. */
export const DIRECT_PARTNER_CATEGORY_LABELS: Record<
  DirectPartnerCategory,
  string
> = {
  AUTOMOTIVO: 'Automotivo',
  ALIMENTACAO: 'Alimentação',
  SAUDE: 'Saúde',
  SERVICOS: 'Serviços',
  LAZER: 'Lazer',
  OUTROS: 'Outros',
};

/** Rótulo de cada tom (cor do tile/badges) para o select do painel. */
export const DIRECT_PARTNER_TONE_LABELS: Record<DirectPartnerTone, string> = {
  ACCENT: 'Vermelho (padrão)',
  INFO: 'Azul',
  SUCCESS: 'Verde',
  WARNING: 'Âmbar',
  HIGHLIGHT: 'Roxo',
};

/** Rótulo de exibição das bases conhecidas; bases novas caem no fallback. */
export const DIRECT_PARTNER_BASE_LABELS: Record<string, string> = {
  MAIS_PRIME: 'Mais Prime',
  MAIS_PRIME_RS: 'Mais Prime RS',
};

/** Status derivado do cupom, exibido no painel. */
export enum DirectPartnerCouponStatus {
  VISIVEL = 'VISIVEL',
  INATIVO = 'INATIVO',
  AGENDADO = 'AGENDADO',
  VENCIDO = 'VENCIDO',
}

/** Horário estruturado de funcionamento (JSON em `DirectPartner.openingHours`). */
export interface DirectPartnerOpeningHour {
  /** 0 = domingo ... 6 = sábado */
  weekday: number;
  /** "08:00" */
  opens: string;
  /** "18:00" */
  closes: string;
}

/** `DirectPartner.alloyalCategoryIds`: ids de categoria Alloyal por base. */
export type AlloyalCategoryIdsByBase = Record<string, number[]>;

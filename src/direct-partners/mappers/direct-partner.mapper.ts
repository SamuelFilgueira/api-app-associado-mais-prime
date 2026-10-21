import {
  DIRECT_PARTNER_CATEGORY_LABELS,
  DirectPartnerCouponStatus,
} from 'src/direct-partners/enums/direct-partner.enums';
import {
  calcularAbertoAgora,
  calcularIniciais,
  cupomVisivel,
  derivarMelhorBeneficio,
  distanciaKm,
  formatarDataCupom,
  lerAlloyalCategoryIds,
  lerCondicoes,
  lerHorarios,
  mascararCpfPainel,
  montarLogradouro,
  statusCupom,
} from 'src/direct-partners/helpers/direct-partner.helpers';
import {
  CouponAdminRecord,
  PartnerAdminRecord,
  PartnerAppRecord,
  RedemptionRecord,
} from 'src/direct-partners/repositories/direct-partners.repository';

export interface Coordenadas {
  lat: number;
  lng: number;
}

/** Último resgate do associado por cupom (detalhe do app, §6.2). */
export type ResgatesPorCupom = Map<number, Date>;

// ------------------------------------------------------------------ painel

export interface DirectPartnerCouponAdmin {
  id: number;
  code: string;
  highlight: string;
  title: string;
  description: string;
  conditions: string[];
  validFrom: string | null;
  validUntil: string;
  singleUse: boolean;
  isActive: boolean;
  sortOrder: number;
  status: DirectPartnerCouponStatus;
  redemptionsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toAdminCoupon(
  cupom: CouponAdminRecord,
  agora: Date = new Date(),
): DirectPartnerCouponAdmin {
  return {
    id: cupom.id,
    code: cupom.code,
    highlight: cupom.highlight,
    title: cupom.title,
    description: cupom.description,
    conditions: lerCondicoes(cupom.conditions),
    validFrom: formatarDataCupom(cupom.validFrom),
    validUntil: formatarDataCupom(cupom.validUntil) ?? '',
    singleUse: cupom.singleUse,
    isActive: cupom.isActive,
    sortOrder: cupom.sortOrder,
    status: statusCupom(cupom, agora),
    redemptionsCount: cupom._count.redemptions,
    createdAt: cupom.createdAt,
    updatedAt: cupom.updatedAt,
  };
}

export function toAdmin(
  parceiro: PartnerAdminRecord,
  options: { includeCoupons: boolean; agora?: Date },
) {
  const agora = options.agora ?? new Date();
  const cupons = parceiro.coupons.map((c) => toAdminCoupon(c, agora));
  const visiveis = parceiro.coupons.filter((c) => cupomVisivel(c, agora));
  const baseOrigins = parceiro.bases.map((b) => b.baseOrigin);

  const visibleInApp =
    parceiro.isActive &&
    parceiro.deletedAt === null &&
    baseOrigins.length > 0 &&
    visiveis.length > 0;

  return {
    id: parceiro.id,
    baseOrigins,
    name: parceiro.name,
    shortDescription: parceiro.shortDescription,
    description: parceiro.description,
    category: parceiro.category,
    categoryLabel:
      parceiro.categoryLabel ??
      DIRECT_PARTNER_CATEGORY_LABELS[parceiro.category],
    alloyalCategoryIds: lerAlloyalCategoryIds(parceiro.alloyalCategoryIds),
    tone: parceiro.tone,
    initials: calcularIniciais(parceiro.name),
    logoUrl: parceiro.logoUrl,
    coverUrl: parceiro.coverUrl,
    address: {
      street: parceiro.street,
      number: parceiro.number,
      complement: parceiro.complement,
      district: parceiro.district,
      city: parceiro.city,
      state: parceiro.state,
      zipCode: parceiro.zipCode,
      reference: parceiro.reference,
      latitude: parceiro.latitude,
      longitude: parceiro.longitude,
    },
    contact: {
      phone: parceiro.phone,
      whatsapp: parceiro.whatsapp,
      website: parceiro.website,
      instagram: parceiro.instagram,
    },
    openingHoursText: parceiro.openingHoursText,
    openingHours: lerHorarios(parceiro.openingHours) ?? [],
    featured: parceiro.featured,
    sortOrder: parceiro.sortOrder,
    isActive: parceiro.isActive,
    visibleInApp,
    deletedAt: parceiro.deletedAt,
    createdAt: parceiro.createdAt,
    updatedAt: parceiro.updatedAt,
    couponsCount: { total: parceiro.coupons.length, visible: visiveis.length },
    redemptionsCount: parceiro.coupons.reduce(
      (soma, c) => soma + c._count.redemptions,
      0,
    ),
    ...(options.includeCoupons ? { coupons: cupons } : {}),
  };
}

export type DirectPartnerAdmin = ReturnType<typeof toAdmin>;

export function toAdminRedemption(resgate: RedemptionRecord) {
  return {
    id: resgate.id,
    redeemedAt: resgate.redeemedAt,
    baseOrigin: resgate.baseOrigin,
    associado: {
      id: resgate.user.id,
      nome: abreviarNome(resgate.user.name),
      cpfMascarado: mascararCpfPainel(resgate.user.cpf),
    },
  };
}

/** "Maria Silva Souza" → "Maria S." (painel não exibe o nome completo). */
export function abreviarNome(nome: string | null | undefined): string {
  const partes = (nome ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '';
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[1][0].toUpperCase()}.`;
}

// --------------------------------------------------------------------- app

function enderecoApp(parceiro: PartnerAppRecord) {
  return {
    logradouro: montarLogradouro(parceiro),
    bairro: parceiro.district,
    cidade: parceiro.city,
    uf: parceiro.state,
    cep: parceiro.zipCode,
    referencia: parceiro.reference,
    latitude: parceiro.latitude,
    longitude: parceiro.longitude,
  };
}

function calcularDistancia(
  parceiro: PartnerAppRecord,
  coords?: Coordenadas,
): number | null {
  if (!coords) return null;
  return distanciaKm(
    coords.lat,
    coords.lng,
    parceiro.latitude,
    parceiro.longitude,
  );
}

function baseApp(
  parceiro: PartnerAppRecord,
  coords: Coordenadas | undefined,
  agora: Date,
) {
  return {
    id: parceiro.id,
    nome: parceiro.name,
    descricaoCurta: parceiro.shortDescription,
    categoria: parceiro.category,
    categoriaLabel:
      parceiro.categoryLabel ??
      DIRECT_PARTNER_CATEGORY_LABELS[parceiro.category],
    tom: parceiro.tone,
    iniciais: calcularIniciais(parceiro.name),
    logoUrl: parceiro.logoUrl,
    destaque: parceiro.featured,
    distanciaKm: calcularDistancia(parceiro, coords),
    abertoAgora: calcularAbertoAgora(lerHorarios(parceiro.openingHours), agora),
    endereco: enderecoApp(parceiro),
  };
}

/** Item da listagem do app (§6.1) — sem cupons. */
export function toAppListItem(
  parceiro: PartnerAppRecord,
  coords?: Coordenadas,
  agora: Date = new Date(),
) {
  const beneficio = derivarMelhorBeneficio(
    parceiro.coupons.map((c) => c.highlight),
  );
  return {
    ...baseApp(parceiro, coords, agora),
    melhorBeneficio: beneficio.melhorBeneficio,
    textoDesconto: beneficio.textoDesconto,
    totalCupons: parceiro.coupons.length,
  };
}

export type DirectPartnerAppListItem = ReturnType<typeof toAppListItem>;

/** Detalhe do app (§6.2) com cupons e estado de resgate do associado. */
export function toAppDetail(
  parceiro: PartnerAppRecord,
  resgates: ResgatesPorCupom,
  coords?: Coordenadas,
  agora: Date = new Date(),
) {
  return {
    ...baseApp(parceiro, coords, agora),
    descricao: parceiro.description,
    coverUrl: parceiro.coverUrl,
    contato: {
      telefone: parceiro.phone,
      whatsapp: parceiro.whatsapp,
      site: parceiro.website,
      instagram: parceiro.instagram,
    },
    horarioTexto: parceiro.openingHoursText,
    horarios: (lerHorarios(parceiro.openingHours) ?? []).map((h) => ({
      diaSemana: h.weekday,
      abre: h.opens,
      fecha: h.closes,
    })),
    cupons: parceiro.coupons.map((cupom) => {
      const resgatadoEm = resgates.get(cupom.id) ?? null;
      const resgatado = resgatadoEm !== null;
      const exibeCodigo = !cupom.singleUse || resgatado;
      return {
        id: cupom.id,
        codigo: exibeCodigo ? cupom.code : null,
        valor: cupom.highlight,
        titulo: cupom.title,
        descricao: cupom.description,
        condicoes: lerCondicoes(cupom.conditions),
        validoDe: formatarDataCupom(cupom.validFrom),
        validoAte: formatarDataCupom(cupom.validUntil),
        usoUnico: cupom.singleUse,
        resgate: { resgatado, resgatadoEm },
      };
    }),
  };
}

export type DirectPartnerAppDetail = ReturnType<typeof toAppDetail>;

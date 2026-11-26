/**
 * Filtros das consultas à Alloyal: recebem os valores como chegam na query
 * do app (texto) e devolvem os parâmetros que vão para a Alloyal. Só entra
 * na consulta o que foi informado — parâmetro vazio não é enviado.
 *
 * A ordem das chaves é a que a integração sempre enviou.
 */
export type Parametros = Record<string, string | number | boolean>;

export interface Coordenadas {
  lat?: string;
  lng?: string;
}

/** Página pedida, ou a primeira. */
export function paginaOuPrimeira(page?: string): number {
  return page ? Number(page) : 1;
}

/** Identificador numérico que veio no caminho da rota. */
export function idNumerico(valor: string): number {
  return Number(valor);
}

export function paramsDeCoordenadas({ lat, lng }: Coordenadas): Parametros {
  const params: Parametros = {};
  if (lat) params.lat = lat;
  if (lng) params.lng = lng;
  return params;
}

export function paramsDeOrganizacoesDaCategoria(
  filtros: Coordenadas & { page?: string },
): Parametros {
  return {
    page: paginaOuPrimeira(filtros.page),
    ...paramsDeCoordenadas(filtros),
  };
}

export interface FiltrosDeOrganizacoes extends Coordenadas {
  page?: string;
  organization_type?: string;
  search?: string;
  category_id?: string;
}

export function paramsDeOrganizacoes(
  filtros: FiltrosDeOrganizacoes,
): Parametros {
  const params: Parametros = {
    page: paginaOuPrimeira(filtros.page),
    ...paramsDeCoordenadas(filtros),
  };
  const categoria = filtros.category_id ? Number(filtros.category_id) : 0;
  if (filtros.organization_type) {
    params.organization_type = filtros.organization_type;
  }
  if (filtros.search) params.search = filtros.search;
  if (categoria) params.category_id = categoria;
  return params;
}

/** A Alloyal só aceita promoções num raio de até 30 km. */
export const DISTANCIA_MAXIMA_KM = 30;

export interface FiltrosDePromocoes extends Coordenadas {
  page?: string;
  redeem_type?: string;
  category_id?: string;
  organization_id?: string;
  distance_km?: string;
  term?: string;
}

export function paramsDePromocoes(filtros: FiltrosDePromocoes): Parametros {
  const numero = (valor?: string) => (valor ? Number(valor) : 0);
  const pagina = numero(filtros.page);
  const categoria = numero(filtros.category_id);
  const organizacao = numero(filtros.organization_id);
  const distancia = numero(filtros.distance_km);

  const params: Parametros = paramsDeCoordenadas(filtros);
  if (pagina) params.page = pagina;
  if (filtros.redeem_type) params.redeem_type = filtros.redeem_type;
  if (categoria) params.category_id = categoria;
  if (organizacao) params.organization_id = organizacao;
  if (distancia) {
    params.distance_km = Math.min(distancia, DISTANCIA_MAXIMA_KM);
  }
  if (filtros.term) params.term = filtros.term;
  return params;
}

/** Cupons da organização: sem tipo de uso informado, lista os online. */
export function paramsDeCuponsDaOrganizacao(usageType?: string): Parametros {
  return { usage_type: usageType === undefined ? 'online' : usageType };
}

export function paramsDeCuponsDaFilial(page?: string): Parametros {
  return { page: paginaOuPrimeira(page) };
}

/** Identificação do cupom nos dois resgates (query de um, corpo do outro). */
export function cupomDoResgate(couponId: string): { coupon_id: number } {
  return { coupon_id: Number(couponId) };
}

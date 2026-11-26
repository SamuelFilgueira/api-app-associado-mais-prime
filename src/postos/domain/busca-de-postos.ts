/**
 * Regras da busca de postos (funções puras): paginação local sobre a lista
 * do Clubgas e a chave do cache dessa lista.
 */

/** Postos por página na resposta ao app. */
export const POSTOS_POR_PAGINA = 5;

/**
 * Por quanto tempo a lista de postos de uma busca é reaproveitada. O Clubgas
 * devolve a lista INTEIRA a cada chamada e o app pagina de 5 em 5: sem cache,
 * rolar a lista repetia a mesma consulta a cada página.
 */
export const TTL_DO_CACHE_DE_POSTOS_SEG = 15 * 60;

/**
 * Casas decimais das coordenadas na chave do cache: 3 casas ≈ 110 m. Leituras
 * de GPS do mesmo lugar (que variam alguns metros entre uma página e outra)
 * caem na mesma chave; quem se desloca de verdade faz uma busca nova.
 */
const CASAS_DA_COORDENADA = 3;

function coordenadaNormalizada(valor: number): string {
  const fator = 10 ** CASAS_DA_COORDENADA;
  // `+ 0` desfaz o zero negativo de `Math.round(-0.0001 * fator)`.
  return (Math.round(valor * fator) / fator + 0).toFixed(CASAS_DA_COORDENADA);
}

/** Placa sem máscara nem caixa: `abc-1d23` e `ABC1D23` são a mesma busca. */
function placaNormalizada(placa: string): string {
  return placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Chave do cache da lista de postos, SEM a base (o `CacheService` a prefixa).
 *
 * A placa faz parte da chave porque é parâmetro da consulta ao Clubgas: é
 * ela que o Clubgas valida, e nada garante que a lista seja a mesma para
 * veículos diferentes.
 */
export function chaveDoCacheDePostos(busca: {
  latitude: number;
  longitude: number;
  placa: string;
}): string {
  return [
    'postos',
    placaNormalizada(busca.placa),
    coordenadaNormalizada(busca.latitude),
    coordenadaNormalizada(busca.longitude),
  ].join(':');
}

export interface PaginaDePostos<T> {
  pagination: {
    totalElements: number;
    pageSize: number;
    pageNumber: number;
    totalPages: number;
  };
  result: T[];
  /** Índices (base 0) do recorte desta página na lista completa. */
  inicio: number;
  fim: number;
}

/** Recorta a página pedida da lista completa devolvida pelo Clubgas. */
export function paginarPostos<T>(
  postos: readonly T[],
  pagina: number,
  porPagina: number = POSTOS_POR_PAGINA,
): PaginaDePostos<T> {
  const totalElements = postos.length;
  const inicio = (pagina - 1) * porPagina;
  const fim = inicio + porPagina;

  return {
    pagination: {
      totalElements,
      pageSize: porPagina,
      pageNumber: pagina,
      totalPages: Math.ceil(totalElements / porPagina),
    },
    result: postos.slice(inicio, fim),
    inicio,
    fim,
  };
}

/**
 * Linha de log de um posto: posição na lista do Clubgas, página em que cai
 * na paginação local e os campos que identificam o posto. `>>` marca os
 * postos devolvidos nesta requisição.
 */
export function descreverPosto(
  posto: unknown,
  indice: number,
  porPagina: number,
  naPaginaAtual: boolean,
): string {
  const p = (posto ?? {}) as Record<string, string | number | undefined>;
  const marcador = naPaginaAtual ? '>>' : '  ';
  const pagina = Math.floor(indice / porPagina) + 1;
  return (
    `${marcador} #${indice + 1} pág.${pagina} | ${p.postoNome ?? '(sem nome)'} | ` +
    `${p.enderecoPosto ?? '(sem endereço)'} | ${p.distancia ?? '?'} km | ` +
    `lat=${p.latitude ?? '?'} lng=${p.longitude ?? '?'} | id=${p.id ?? '?'}`
  );
}

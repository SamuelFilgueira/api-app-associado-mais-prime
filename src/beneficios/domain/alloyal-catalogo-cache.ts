/**
 * O que do catálogo da Alloyal pode ser guardado em cache, com que chave e
 * por quanto tempo (funções puras).
 *
 * Só entra no cache o que é IGUAL para todos os associados da base:
 *
 * | Recurso                                 | Cache | Por quê                                    |
 * |-----------------------------------------|-------|--------------------------------------------|
 * | categorias                              | 6 h   | sem parâmetro; muda raramente              |
 * | destaques online                        | 3 h   | sem parâmetro                              |
 * | organizações (sem coordenada nem busca) | 1 h   | só página e tipo, de conjunto fechado      |
 * | organizações com `lat`/`lng`            | não   | `distance_km` e a ordem variam por ponto   |
 * | organizações com `search`/`category_id` | não   | texto livre/id arbitrário: chaves sem teto |
 * | organizações da categoria               | não   | traz `favorited`, que é do usuário         |
 * | mais próximas / destaques próximos      | não   | resultado é função da posição do usuário   |
 * | filiais, promoções, cupons, pedidos     | não   | distância, estoque e uso por usuário       |
 * | cashback, usuários, sessão              | não   | dado do usuário                            |
 *
 * Arredondar a coordenada não serve: a resposta traz a distância com duas
 * casas (10 m), então dois pontos vizinhos já dão resultados diferentes.
 *
 * O Redis do cache é o mesmo das filas e não descarta chaves sozinho: toda
 * chave daqui vem de um conjunto fechado (no máximo
 * `tipos × PAGINA_MAXIMA` por base).
 */

const HORA = 3_600;

/**
 * Por quanto tempo o resumo das categorias (id e título) fica guardado para
 * o painel; ver `AlloyalCategoriesCacheService`. Não é cache de leitura do
 * vendor — o painel não tem sessão na Alloyal e só conhece o que o app
 * carregou —, por isso não é configurável nem pode ser zerado.
 *
 * Os prazos do que o app lê (6 h, 3 h e 1 h por padrão) são configuração:
 * `prazosDoCacheAlloyal()` em `src/config/integracoes.config.ts`.
 */
export const PRAZO_CATEGORIAS_DO_PAINEL_SEG = 7 * 24 * HORA;

export const CHAVE_CATEGORIAS = 'alloyal:catalogo:categorias';
export const CHAVE_DESTAQUES_ONLINE = 'alloyal:catalogo:destaques_online';
export const CHAVE_CATEGORIAS_DO_PAINEL = 'alloyal:catalogo:categorias_painel';

/** Páginas além desta não são guardadas (teto do número de chaves). */
export const PAGINA_MAXIMA = 50;

/** Tipos de organização que o app envia → trecho da chave. */
const TIPOS_DE_ORGANIZACAO: Readonly<Record<string, string>> = {
  online: 'online',
  física: 'fisica',
};

/**
 * Chave do cache de `GET /organizations` para os parâmetros que VÃO para a
 * Alloyal, ou `null` quando a consulta não pode ser guardada.
 */
export function chaveDeOrganizacoes(
  params: Readonly<Record<string, string | number | boolean>>,
): string | null {
  const permitidos = new Set(['page', 'organization_type']);
  if (Object.keys(params).some((nome) => !permitidos.has(nome))) return null;

  const pagina = params.page;
  if (
    typeof pagina !== 'number' ||
    !Number.isInteger(pagina) ||
    pagina < 1 ||
    pagina > PAGINA_MAXIMA
  ) {
    return null;
  }

  let tipo = 'todos';
  if (params.organization_type !== undefined) {
    const conhecido = Object.prototype.hasOwnProperty.call(
      TIPOS_DE_ORGANIZACAO,
      String(params.organization_type),
    )
      ? TIPOS_DE_ORGANIZACAO[String(params.organization_type)]
      : undefined;
    if (!conhecido) return null;
    tipo = conhecido;
  }

  return `alloyal:catalogo:organizacoes:${tipo}:p${pagina}`;
}

/**
 * Resposta que vale guardar: lista com pelo menos um item. Lista vazia pode
 * ser instabilidade da Alloyal — guardá-la esconderia o catálogo por horas.
 */
export function listaComItens(valor: unknown): boolean {
  return Array.isArray(valor) && valor.length > 0;
}

export interface AlloyalCategoriaResumo {
  id: number;
  title: string;
}

/** Id e título das categorias, para o formulário de parceiros do painel. */
export function resumirCategorias(
  categorias: unknown,
): AlloyalCategoriaResumo[] {
  if (!Array.isArray(categorias)) return [];
  return (categorias as Array<Record<string, unknown> | null>)
    .filter(
      (categoria) =>
        !!categoria &&
        typeof categoria === 'object' &&
        Number.isInteger(categoria.id),
    )
    .map((categoria) => ({
      id: Number(categoria!.id),
      title: String((categoria!.title ?? '') as string),
    }));
}

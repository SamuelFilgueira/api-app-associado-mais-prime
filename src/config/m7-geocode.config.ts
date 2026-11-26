/**
 * Knobs do reverse geocode / relatório de contestação V2 da M7.
 *
 * Único ponto que lê `process.env` para esse fluxo (regra do CLAUDE.md:
 * `process.env` novo só em `config/`). Todos têm default seguro e estão
 * documentados no `.env.example` e em `env.validator.ts` (opcionais).
 */

function lerInteiro(
  nome: string,
  padrao: number,
  min: number,
  max: number,
): number {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto.trim() === '') return padrao;
  const numero = Number(bruto);
  if (!Number.isFinite(numero)) return padrao;
  return Math.min(max, Math.max(min, Math.trunc(numero)));
}

/** Conexões MySQL que uma consulta de reverse geocode ocupa (rua, bairro, cidade). */
const CONEXOES_POR_CONSULTA = 3;

/**
 * Quantas consultas de reverse geocode podem rodar ao mesmo tempo NO
 * PROCESSO, somando todas as requisições.
 *
 * Deriva do pool do Prisma (`PRISMA_CONNECTION_LIMIT`, o mesmo valor lido em
 * `database/prisma.service.ts`): reserva 30% do pool (mínimo 3 conexões) para
 * o resto da API — login, boletos, sincronização — e divide o que sobra
 * pelas 3 conexões de cada consulta. Com pool de 40 dá 9; com pool de 10
 * (réplica da API) dá 2. Antes o limite era só por requisição: duas
 * contestações ao mesmo tempo pediam 48 conexões.
 */
function consultasSimultaneasPadrao(): number {
  const pool = lerInteiro('PRISMA_CONNECTION_LIMIT', 40, 1, 1_000);
  const reserva = Math.max(3, Math.ceil(pool * 0.3));
  return Math.max(1, Math.floor((pool - reserva) / CONEXOES_POR_CONSULTA));
}

export const M7_GEOCODE_CONFIG = {
  /**
   * Teto global de consultas simultâneas ao Nominatim neste processo.
   * `M7_REV_GEOCODE_MAX_CONSULTAS` sobrescreve o valor derivado do pool.
   */
  consultasSimultaneas: lerInteiro(
    'M7_REV_GEOCODE_MAX_CONSULTAS',
    consultasSimultaneasPadrao(),
    1,
    64,
  ),
  /** Workers simultâneos do pool de reverse geocode (cada um usa até 3 conexões MySQL). */
  concorrencia: lerInteiro('M7_REV_GEOCODE_CONCURRENCY', 8, 1, 16),
  /** Distância máxima (m) para um ponto herdar o endereço de uma âncora já geocodificada. 0 desliga. */
  herancaMetros: lerInteiro('M7_REV_GEOCODE_HERANCA_METROS', 20, 0, 200),
  /** Tamanho máximo do cache em memória (entradas). */
  memCacheMax: lerInteiro(
    'M7_REV_GEOCODE_MEM_CACHE_MAX',
    50_000,
    1_000,
    1_000_000,
  ),
  /** Orçamento de tempo (ms) para o geocode de uma requisição; excedido → fallback "lat, lon". */
  budgetMs: lerInteiro('M7_REV_GEOCODE_BUDGET_MS', 90_000, 1_000, 600_000),
  /** TTL (s) das entradas no Redis; renovado a cada hit. Default 7 dias. */
  redisTtlSeg: lerInteiro(
    'M7_REV_GEOCODE_REDIS_TTL_SEG',
    604_800,
    60,
    31_536_000,
  ),
  /** Intervalo mínimo (s) entre linhas do PDF de contestação V2. 0 desliga a amostragem. */
  intervaloMinSeg: lerInteiro('M7_CONTESTACAO_INTERVALO_MIN_SEG', 10, 0, 3_600),
  /** Pontos por chunk no pipeline de streaming do PDF. */
  chunkPontos: lerInteiro('M7_CONTESTACAO_CHUNK_PONTOS', 500, 50, 5_000),
} as const;

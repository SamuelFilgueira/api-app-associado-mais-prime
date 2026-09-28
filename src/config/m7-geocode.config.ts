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

export const M7_GEOCODE_CONFIG = {
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

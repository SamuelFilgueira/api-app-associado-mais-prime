import { isTenantBase } from 'src/config/tenant.config';
import { contextoExecucao } from 'src/infra/observability/contexto-execucao';

/** Versão do formato do payload. Sobe quando um campo muda de sentido. */
export const VERSAO_DO_PAYLOAD = 1;

/**
 * Metadados que todo job carrega além dos dados do domínio.
 *
 * `baseOrigin` fica no nível de cima do payload (é dado de negócio: decide
 * qual credencial o worker usa). `_meta` é só rastreio.
 */
export interface MetadadosDoJob {
  /** Requisição (ou job) que originou este job: segue o fio no log. */
  requestId?: string;
  /** Versão do formato. */
  v: number;
  /** Quando o job foi criado (ISO). */
  criadoEm: string;
}

export type ComEnvelope<T> = T & {
  baseOrigin?: string;
  _meta?: MetadadosDoJob;
};

/**
 * Acrescenta ao payload a base e os metadados de rastreio. A base é opcional
 * só para os jobs que valem para o deploy inteiro (régua diária, expurgos).
 */
export function comEnvelope<T extends object>(
  dados: T,
  base?: string | null,
): ComEnvelope<T> {
  return {
    ...dados,
    ...(base ? { baseOrigin: base } : {}),
    _meta: {
      requestId: contextoExecucao.requestId(),
      v: VERSAO_DO_PAYLOAD,
      criadoEm: new Date().toISOString(),
    },
  };
}

/**
 * Base do job, validada contra as bases deste deploy. `null` quando o
 * payload não a traz (job antigo, criado antes de a base ir no payload) ou
 * traz um valor desconhecido — o processor decide: rederivar do banco ou
 * falhar, mas nunca assumir a base padrão.
 */
export function baseDoJob(dados: unknown): string | null {
  const base = (dados as { baseOrigin?: unknown } | null)?.baseOrigin;
  return isTenantBase(base) ? base : null;
}

export function metadadosDoJob(dados: unknown): MetadadosDoJob | undefined {
  const meta = (dados as { _meta?: unknown } | null)?._meta;
  return meta && typeof meta === 'object'
    ? (meta as MetadadosDoJob)
    : undefined;
}

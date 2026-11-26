import {
  ALLOWED_ACTIONS,
  ALLOWED_FORMS,
  ALLOWED_SCREENS,
  MAX_PAYLOAD_BYTES,
  MAX_PERIOD_MS,
} from 'src/analytics/constants/analytics-allowlists';
import {
  CLAMP,
  clampInt,
  sanitizeVersionString,
} from 'src/analytics/utils/analytics-sanitizer.util';

/**
 * Regras do summary RECEBIDO do app (funções puras): tamanho, período,
 * allowlists de telas/ações/formulários e o payload sanitizado que segue
 * para a fila. Nada aqui grava nem lê: a entrada é o corpo já validado pelo
 * schema, a saída é o que pode ser persistido.
 */

export interface TelaRecebida {
  screen: string;
  view_count: number;
  total_time_ms: number;
}

export interface AcaoRecebida {
  action: string;
  count: number;
}

export interface FormularioRecebido {
  screen: string;
  form: string;
  started_count: number;
  submitted_count: number;
  success_count: number;
  error_count: number;
}

/** O corpo serializado passa do limite aceito pela ingestão (64 KB)? */
export function excedeTamanhoMaximo(payloadSerializado: string): boolean {
  return payloadSerializado.length > MAX_PAYLOAD_BYTES;
}

export type PeriodoInvalido =
  | 'DATAS_INVALIDAS'
  | 'FIM_NAO_POSTERIOR_AO_INICIO'
  | 'JANELA_MAIOR_QUE_O_LIMITE';

/** Mensagem devolvida ao app (HTTP 422) para cada recusa do período. */
export const MENSAGEM_DE_PERIODO_INVALIDO: Record<PeriodoInvalido, string> = {
  DATAS_INVALIDAS: 'Datas inválidas no payload',
  FIM_NAO_POSTERIOR_AO_INICIO: 'period_end deve ser maior que period_start',
  JANELA_MAIOR_QUE_O_LIMITE: 'Janela de período excede 1 hora',
};

/** `null` quando o período do summary é aceito. */
export function validarPeriodo(
  inicio: Date,
  fim: Date,
): PeriodoInvalido | null {
  if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) return 'DATAS_INVALIDAS';
  if (fim <= inicio) return 'FIM_NAO_POSTERIOR_AO_INICIO';
  if (fim.getTime() - inicio.getTime() > MAX_PERIOD_MS) {
    return 'JANELA_MAIOR_QUE_O_LIMITE';
  }
  return null;
}

export interface ItensAceitos {
  screens: TelaRecebida[];
  actions: AcaoRecebida[];
  forms: FormularioRecebido[];
  /** Itens fora das allowlists (vão para o recibo como descarte). */
  descartados: number;
}

/**
 * Fica só o que está nas allowlists, com os contadores limitados às faixas
 * aceitas. Item fora da allowlist é descartado sem recusar o summary.
 */
export function filtrarPelasAllowlists(recebido: {
  screens: readonly TelaRecebida[];
  actions: readonly AcaoRecebida[];
  forms?: readonly FormularioRecebido[];
}): ItensAceitos {
  const screens = recebido.screens
    .filter((s) => ALLOWED_SCREENS.has(s.screen))
    .map((s) => ({
      screen: s.screen,
      view_count: clampInt(
        s.view_count,
        CLAMP.VIEW_COUNT.min,
        CLAMP.VIEW_COUNT.max,
      ),
      total_time_ms: clampInt(
        s.total_time_ms,
        CLAMP.TOTAL_TIME_MS.min,
        CLAMP.TOTAL_TIME_MS.max,
      ),
    }));

  const actions = recebido.actions
    .filter((a) => ALLOWED_ACTIONS.has(a.action))
    .map((a) => ({
      action: a.action,
      count: clampInt(a.count, CLAMP.ACTION_COUNT.min, CLAMP.ACTION_COUNT.max),
    }));

  const contadorDeFormulario = (valor: number) =>
    clampInt(valor, CLAMP.FORM_COUNT.min, CLAMP.FORM_COUNT.max);
  const forms = (recebido.forms ?? [])
    .filter((f) => ALLOWED_FORMS.has(f.form))
    .map((f) => ({
      screen: f.screen,
      form: f.form,
      started_count: contadorDeFormulario(f.started_count),
      submitted_count: contadorDeFormulario(f.submitted_count),
      success_count: contadorDeFormulario(f.success_count),
      error_count: contadorDeFormulario(f.error_count),
    }));

  const descartados =
    recebido.screens.length -
    screens.length +
    recebido.actions.length -
    actions.length +
    (recebido.forms?.length ?? 0) -
    forms.length;

  return { screens, actions, forms, descartados };
}

/**
 * Summary sanitizado: é o que trafega no job e a base do `payloadHash`. A
 * ordem das chaves faz parte do hash — não reordenar.
 */
export interface ResumoSanitizado {
  period_start: string;
  period_end: string;
  platform: string;
  app_version: string;
  runtime_version?: string;
  install_hash: string;
  session_hash: string;
  screens: TelaRecebida[];
  actions: AcaoRecebida[];
  forms: FormularioRecebido[];
}

export function montarResumoSanitizado(entrada: {
  periodStart: string;
  periodEnd: string;
  platform: string;
  version: unknown;
  runtimeVersion: unknown;
  installHash: string;
  sessionHash: string;
  aceitos: Pick<ItensAceitos, 'screens' | 'actions' | 'forms'>;
}): ResumoSanitizado {
  return {
    period_start: entrada.periodStart,
    period_end: entrada.periodEnd,
    platform: entrada.platform,
    app_version: sanitizeVersionString(entrada.version) ?? '',
    runtime_version: sanitizeVersionString(entrada.runtimeVersion),
    install_hash: entrada.installHash,
    session_hash: entrada.sessionHash,
    screens: entrada.aceitos.screens,
    actions: entrada.aceitos.actions,
    forms: entrada.aceitos.forms,
  };
}

/**
 * Id do usuário vindo do JWT, quando é um inteiro positivo (número ou texto
 * numérico). Qualquer outra coisa vira `null`.
 */
export function normalizarIdDoUsuario(valor: unknown): number | null {
  if (typeof valor === 'number' && Number.isInteger(valor) && valor > 0) {
    return valor;
  }
  if (typeof valor === 'string') {
    const numero = Number.parseInt(valor, 10);
    if (Number.isInteger(numero) && numero > 0) return numero;
  }
  return null;
}

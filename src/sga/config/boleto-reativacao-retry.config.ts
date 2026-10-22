/**
 * Configuração do retry de criação do boleto de reativação
 * (`BoletoReativacaoService` + `BoletoReativacaoRetryProcessor`).
 *
 * Quando a aprovação da revistoria não consegue cadastrar o boleto por
 * instabilidade do SGA, a revistoria fica `boletoStatus = PENDENTE_RETRY` e
 * um job tenta de novo a cada `intervaloMin` minutos, por no máximo
 * `maxHoras` horas contadas da primeira tentativa. Cada tentativa consulta
 * antes se já existe boleto de reativação em aberto no SGA (criado à mão
 * por uma operadora) e, se existir, adota-o em vez de cadastrar outro.
 */

export const JOB_RETRY_BOLETO_REATIVACAO = 'retry-boleto-reativacao';
export const JOB_ID_PREFIXO_RETRY_BOLETO = 'boleto-reativacao-retry-';

const MINUTO_MS = 60_000;
const HORA_MS = 3_600_000;

export interface BoletoReativacaoRetryConfig {
  /** Intervalo entre tentativas (minutos). */
  intervaloMin: number;
  /** Janela máxima de retry a partir da primeira tentativa (horas). */
  maxHoras: number;
  /**
   * Ao procurar boleto já existente no SGA, aceita vencimento original de
   * hoje até hoje + N dias (o boleto gerado pela API vence amanhã; o criado
   * à mão pode ter vencimento mais longo).
   */
  janelaVencimentoDias: number;
}

function parseInteiro(
  nome: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${nome}="${value}" inválido: esperado inteiro entre ${min} e ${max}`,
    );
  }
  return parsed;
}

export function loadBoletoReativacaoRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): BoletoReativacaoRetryConfig {
  return {
    intervaloMin: parseInteiro(
      'BOLETO_REATIVACAO_RETRY_INTERVALO_MIN',
      env.BOLETO_REATIVACAO_RETRY_INTERVALO_MIN,
      5,
      1,
      1440,
    ),
    maxHoras: parseInteiro(
      'BOLETO_REATIVACAO_RETRY_MAX_HORAS',
      env.BOLETO_REATIVACAO_RETRY_MAX_HORAS,
      24,
      1,
      720,
    ),
    janelaVencimentoDias: parseInteiro(
      'BOLETO_REATIVACAO_JANELA_VENCIMENTO_DIAS',
      env.BOLETO_REATIVACAO_JANELA_VENCIMENTO_DIAS,
      45,
      1,
      365,
    ),
  };
}

let configMemo: BoletoReativacaoRetryConfig | undefined;

export function getBoletoReativacaoRetryConfig(): BoletoReativacaoRetryConfig {
  if (!configMemo) {
    configMemo = loadBoletoReativacaoRetryConfig();
  }
  return configMemo;
}

export function intervaloRetryMs(config: BoletoReativacaoRetryConfig): number {
  return config.intervaloMin * MINUTO_MS;
}

/** Já passou a janela máxima de retry desde a primeira tentativa. */
export function excedeuJanelaRetry(
  config: BoletoReativacaoRetryConfig,
  primeiraTentativaEm: number,
  agora: number,
): boolean {
  return agora - primeiraTentativaEm >= config.maxHoras * HORA_MS;
}

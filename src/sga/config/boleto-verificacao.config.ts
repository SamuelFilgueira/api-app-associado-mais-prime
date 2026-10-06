/**
 * Configuração do poller que verifica o pagamento do boleto de reativação
 * (`BoletoVerificacaoProcessor`), lida do env uma única vez.
 *
 * Contexto: o poller era um repeatable BullMQ de 2 em 2 minutos SEM fim.
 * Cada boleto não pago gerava 720–1440 chamadas/dia ao SGA
 * (`processa-pdf/boleto`, que gera PDF) para sempre, e todos os pollers
 * disparavam no mesmo instante (o BullMQ alinha `every` ao relógio).
 * A Hinova classifica isso como "comportamento agressivo ao recurso" e
 * bloqueia o token. Aqui ficam os limites: cadência por idade do boleto,
 * idade máxima e espaçamento entre chamadas.
 */

export const JOB_VERIFICAR_BOLETO = 'verificar-boleto';
export const JOB_ID_PREFIXO_VERIFICACAO = 'boleto-verificacao-';

/**
 * Intervalo do repeatable no BullMQ (inalterado). A cadência real por idade
 * do boleto é aplicada no processor, que pula o disparo quando ainda não é
 * hora de consultar o SGA.
 */
export const INTERVALO_BASE_MS = 120_000;

const MINUTO_MS = 60_000;
const DIA_MS = 86_400_000;

export interface BoletoVerificacaoConfig {
  /** Intervalo do repeatable no BullMQ (ms). */
  intervaloBaseMs: number;
  /** Idade máxima do boleto (dias): depois disso o poller é encerrado. */
  maxDias: number;
  /** Boleto com mais de 24h: intervalo entre consultas ao SGA (minutos). */
  intervaloApos24hMin: number;
  /** Boleto com mais de 7 dias: intervalo entre consultas ao SGA (minutos). */
  intervaloApos7dMin: number;
  /** Espaçamento mínimo entre consultas consecutivas do poller ao SGA (ms). */
  espacamentoMs: number;
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

/** Carrega a configuração do env, com defaults e validação. */
export function loadBoletoVerificacaoConfig(
  env: NodeJS.ProcessEnv = process.env,
): BoletoVerificacaoConfig {
  return {
    intervaloBaseMs: INTERVALO_BASE_MS,
    maxDias: parseInteiro(
      'BOLETO_VERIFICACAO_MAX_DIAS',
      env.BOLETO_VERIFICACAO_MAX_DIAS,
      30,
      1,
      365,
    ),
    intervaloApos24hMin: parseInteiro(
      'BOLETO_VERIFICACAO_INTERVALO_APOS_24H_MIN',
      env.BOLETO_VERIFICACAO_INTERVALO_APOS_24H_MIN,
      10,
      2,
      1440,
    ),
    intervaloApos7dMin: parseInteiro(
      'BOLETO_VERIFICACAO_INTERVALO_APOS_7D_MIN',
      env.BOLETO_VERIFICACAO_INTERVALO_APOS_7D_MIN,
      60,
      2,
      1440,
    ),
    espacamentoMs: parseInteiro(
      'BOLETO_VERIFICACAO_ESPACAMENTO_MS',
      env.BOLETO_VERIFICACAO_ESPACAMENTO_MS,
      1500,
      0,
      60_000,
    ),
  };
}

let configMemo: BoletoVerificacaoConfig | undefined;

/** Configuração carregada uma única vez (memoizada). */
export function getBoletoVerificacaoConfig(): BoletoVerificacaoConfig {
  if (!configMemo) {
    configMemo = loadBoletoVerificacaoConfig();
  }
  return configMemo;
}

/** Intervalo mínimo entre consultas ao SGA para um boleto com a idade dada. */
export function intervaloConsultaMs(
  config: BoletoVerificacaoConfig,
  idadeMs: number,
): number {
  if (idadeMs >= 7 * DIA_MS) return config.intervaloApos7dMin * MINUTO_MS;
  if (idadeMs >= DIA_MS) return config.intervaloApos24hMin * MINUTO_MS;
  return config.intervaloBaseMs;
}

/**
 * Decide se o disparo atual do repeatable deve consultar o SGA.
 * Nas primeiras 24h consulta sempre (cadência original de 2 min). Depois,
 * só quando passou o intervalo da faixa desde a última consulta — com meia
 * janela de tolerância, porque o repeatable só dispara a cada
 * `intervaloBaseMs` (sem ela, "10 min" viraria 10–12 min).
 */
export function deveConsultarSga(
  config: BoletoVerificacaoConfig,
  params: {
    criadoEm: number;
    ultimaConsultaEm: number | null;
    agora: number;
  },
): boolean {
  const intervalo = intervaloConsultaMs(config, params.agora - params.criadoEm);
  if (intervalo <= config.intervaloBaseMs) return true;
  if (params.ultimaConsultaEm === null) return true;
  return (
    params.agora - params.ultimaConsultaEm >=
    intervalo - config.intervaloBaseMs / 2
  );
}

/** Boleto mais velho que a idade máxima configurada. */
export function excedeuIdadeMaxima(
  config: BoletoVerificacaoConfig,
  criadoEm: number,
  agora: number,
): boolean {
  return agora - criadoEm > config.maxDias * DIA_MS;
}

/** `endDate` do repeatable: instante em que o BullMQ para de reagendar. */
export function prazoFinalPoller(
  config: BoletoVerificacaoConfig,
  agora: number = Date.now(),
): number {
  return agora + config.maxDias * DIA_MS;
}

import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Registro único de métricas do processo (Prometheus, via `prom-client`).
 *
 * Os nomes abaixo são contrato com as regras de alerta em
 * `ops/alertas/regras.yml`: renomear aqui exige renomear lá.
 *
 * Cuidado com cardinalidade: label só recebe valor de conjunto fechado —
 * rota em template, nome de fila, vendor, base. Nunca id, CPF, chassi ou URL.
 */
export const registroDeMetricas = new Registry();

const BUCKETS_HTTP = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
const BUCKETS_VENDOR = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 45, 60];
const BUCKETS_JOB = [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 900];

export const metricas = {
  httpRequisicoes: new Counter({
    name: 'http_requests_total',
    help: 'Requisições HTTP atendidas',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registroDeMetricas],
  }),
  httpDuracao: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duração das requisições HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: BUCKETS_HTTP,
    registers: [registroDeMetricas],
  }),

  vendorRequisicoes: new Counter({
    name: 'vendor_requests_total',
    help: 'Chamadas a APIs de terceiros (resultado: ok|erro|timeout|circuito_aberto)',
    labelNames: ['vendor', 'base', 'operacao', 'resultado'] as const,
    registers: [registroDeMetricas],
  }),
  vendorDuracao: new Histogram({
    name: 'vendor_request_duration_seconds',
    help: 'Duração das chamadas a APIs de terceiros',
    labelNames: ['vendor', 'operacao'] as const,
    buckets: BUCKETS_VENDOR,
    registers: [registroDeMetricas],
  }),
  vendorCircuito: new Gauge({
    name: 'vendor_circuit_state',
    help: 'Estado do circuit breaker por vendor e base (0 fechado, 0.5 meio-aberto, 1 aberto)',
    labelNames: ['vendor', 'base'] as const,
    registers: [registroDeMetricas],
  }),
  cache: new Counter({
    name: 'cache_requests_total',
    help: 'Leituras de cache (resultado: acerto|falta|antigo|erro)',
    labelNames: ['recurso', 'resultado'] as const,
    registers: [registroDeMetricas],
  }),

  filaJobs: new Gauge({
    name: 'queue_jobs',
    help: 'Jobs por fila e estado (waiting|active|delayed|failed)',
    labelNames: ['queue', 'state'] as const,
    registers: [registroDeMetricas],
  }),
  filaIdadeMaisAntigo: new Gauge({
    name: 'queue_oldest_waiting_age_seconds',
    help: 'Idade do job mais antigo em espera, por fila',
    labelNames: ['queue'] as const,
    registers: [registroDeMetricas],
  }),
  filaProcessados: new Counter({
    name: 'queue_jobs_processed_total',
    help: 'Jobs processados (resultado: ok|falha|descartado)',
    labelNames: ['queue', 'name', 'resultado'] as const,
    registers: [registroDeMetricas],
  }),
  filaDuracao: new Histogram({
    name: 'queue_job_duration_seconds',
    help: 'Duração do processamento de jobs',
    labelNames: ['queue', 'name'] as const,
    buckets: BUCKETS_JOB,
    registers: [registroDeMetricas],
  }),
  dlqJobs: new Counter({
    name: 'dlq_jobs_total',
    help: 'Jobs enviados à fila de mortos',
    labelNames: ['queue'] as const,
    registers: [registroDeMetricas],
  }),
  dlqTamanho: new Gauge({
    name: 'dlq_size',
    help: 'Jobs parados na fila de mortos',
    labelNames: ['queue'] as const,
    registers: [registroDeMetricas],
  }),

  rateLimit: new Counter({
    name: 'rate_limit_hits_total',
    help: 'Decisões do limitador (resultado: permitido|bloqueado|observado|erro_redis)',
    labelNames: ['politica', 'resultado'] as const,
    registers: [registroDeMetricas],
  }),
  errosNaoTratados: new Counter({
    name: 'app_unhandled_errors_total',
    help: 'Erros não tratados (tipo: unhandledRejection|uncaughtException|http_500)',
    labelNames: ['tipo'] as const,
    registers: [registroDeMetricas],
  }),
  baseAusente: new Counter({
    name: 'tenant_base_resolucao_total',
    help: 'Resolução da base na borda (origem: jwt|banco|ausente|invalida)',
    labelNames: ['origem'] as const,
    registers: [registroDeMetricas],
  }),

  sgaAuthFalhas: new Counter({
    name: 'sga_auth_falhas_total',
    help: 'Falhas de autenticação no SGA (Hinova)',
    labelNames: ['base'] as const,
    registers: [registroDeMetricas],
  }),
  hinovaTokenBloqueado: new Counter({
    name: 'hinova_token_bloqueado_total',
    help: 'Tokens de base bloqueados pela Hinova por extração de dados',
    labelNames: ['base'] as const,
    registers: [registroDeMetricas],
  }),
  boletoReativacao: new Counter({
    name: 'boleto_reativacao_total',
    help: 'Eventos do boleto de reativação (evento: gerado|falha_geracao|pago|reativado|falha_reativacao|expirado)',
    labelNames: ['base', 'evento'] as const,
    registers: [registroDeMetricas],
  }),
  boletoReguaUltimaExecucao: new Gauge({
    name: 'boleto_regua_ultima_execucao_timestamp_seconds',
    help: 'Instante da última execução concluída da régua de boletos',
    labelNames: ['base'] as const,
    registers: [registroDeMetricas],
  }),
  marketingEmEnvioIdade: new Gauge({
    name: 'marketing_disparo_em_envio_idade_seconds',
    help: 'Idade do disparo de marketing mais antigo ainda em SENDING (0 se não houver)',
    registers: [registroDeMetricas],
  }),
  pushEnviados: new Counter({
    name: 'push_enviados_total',
    help: 'Pushes entregues ao Expo (resultado: ok|erro|token_invalido)',
    labelNames: ['tipo', 'resultado'] as const,
    registers: [registroDeMetricas],
  }),
  vendorErro200: new Counter({
    name: 'vendor_erro_como_sucesso_total',
    help: 'Respostas de erro de vendor devolvidas ao app com status de sucesso (contrato legado)',
    labelNames: ['vendor', 'rota'] as const,
    registers: [registroDeMetricas],
  }),
  pdfRenderizacoes: new Counter({
    name: 'pdf_render_total',
    help: 'Renderizações de PDF (resultado: ok|erro|timeout)',
    labelNames: ['modelo', 'resultado'] as const,
    registers: [registroDeMetricas],
  }),
};

let padraoIniciado = false;

/**
 * Liga as métricas de processo (CPU, heap, atraso do event loop, GC). Chamada
 * uma vez no bootstrap — não no import, para não deixar timers nos testes.
 */
export function iniciarMetricasDeProcesso(role: string): void {
  if (padraoIniciado) return;
  padraoIniciado = true;
  registroDeMetricas.setDefaultLabels({ role });
  collectDefaultMetrics({ register: registroDeMetricas });
}

/**
 * Mede uma chamada a vendor: duração e resultado, com timeout contado à
 * parte. Reaproveitada pelos clients em `src/integrations`.
 */
export async function medirVendor<T>(
  rotulos: { vendor: string; base?: string; operacao: string },
  executar: () => Promise<T>,
  classificar: (erro: unknown) => 'erro' | 'timeout' | 'circuito_aberto' = () =>
    'erro',
): Promise<T> {
  const fim = metricas.vendorDuracao.startTimer({
    vendor: rotulos.vendor,
    operacao: rotulos.operacao,
  });
  const base = rotulos.base ?? 'n/a';
  try {
    const resultado = await executar();
    metricas.vendorRequisicoes.inc({ ...rotulos, base, resultado: 'ok' });
    return resultado;
  } catch (erro) {
    metricas.vendorRequisicoes.inc({
      ...rotulos,
      base,
      resultado: classificar(erro),
    });
    throw erro;
  } finally {
    fim();
  }
}

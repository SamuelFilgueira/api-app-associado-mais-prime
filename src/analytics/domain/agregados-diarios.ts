import {
  JOURNEY_LOGIN_ACTION,
  JOURNEY_LOGOUT_ACTION,
} from 'src/analytics/constants/analytics-journey.constants';
import type { ResumoSanitizado } from 'src/analytics/domain/resumo-recebido';
import { saoPauloDay } from 'src/analytics/utils/analytics-day.util';
import type {
  SanitizedDeviceInfo,
  SanitizedJourneyEvent,
} from 'src/analytics/utils/analytics-journey.util';
import { sanitizeVersionString } from 'src/analytics/utils/analytics-sanitizer.util';

/**
 * Regra de montagem da ingestão de um summary (funções puras): o que entra
 * em cada tabela, com quais chaves e quais somas. Quem grava é o
 * `AnalyticsIngestaoRepository`; aqui não há banco.
 */

/** Bloco de jornada do job (presente só com ANALYTICS_JOURNEY_ENABLED=true). */
export interface JornadaDoResumo {
  device: SanitizedDeviceInfo | null;
  events: SanitizedJourneyEvent[];
  clientIp: string | null;
}

/** Payload do job `process-summary`, como o `AnalyticsService.ingest` o enfileira. */
export interface DadosDoResumo {
  sanitizedPayload: ResumoSanitizado;
  installHash: string;
  sessionHash: string;
  payloadHash: string;
  discardedItemsCount: number;
  acceptedScreensCount: number;
  acceptedActionsCount: number;
  acceptedFormsCount: number;
  /** Preenchido apenas quando ANALYTICS_LINK_USER_ENABLED=true e JWT válido presente. */
  analyticsUserId?: number | null;
  /** Presente apenas quando ANALYTICS_JOURNEY_ENABLED=true. */
  journey?: JornadaDoResumo;
}

/** Dimensões comuns a todos os agregados diários de um summary. */
export interface ChaveDoDia {
  /** Dia de negócio (fuso de São Paulo), como valor de coluna `DATE`. */
  dia: Date;
  plataforma: string;
  appVersion: string;
}

export interface LinhaDeTela {
  screen: string;
  viewCount: number;
  totalTimeMs: number;
}

export interface LinhaDeAcao {
  action: string;
  count: number;
}

export interface LinhaDeFormulario {
  screen: string;
  form: string;
  startedCount: number;
  submittedCount: number;
  successCount: number;
  errorCount: number;
}

export interface ReciboDoResumo {
  periodStart: Date;
  periodEnd: Date;
  platform: string;
  appVersion: string;
  runtimeVersion: string | undefined;
  installHash: string;
  sessionHash: string;
  acceptedScreensCount: number;
  acceptedActionsCount: number;
  acceptedFormsCount: number;
  discardedItemsCount: number;
  validationStatus: 'ACCEPTED' | 'PARTIAL';
  payloadHash: string;
  analyticsUserId: number | null;
  journeyEventsCount: number;
}

export type TipoDeEventoDaJornada = 'SCREEN' | 'ACTION' | 'FORM';

export interface EventoDaJornada {
  occurredAt: Date;
  /** Posição do evento dentro do summary (já ordenado por horário). */
  seq: number;
  eventType: TipoDeEventoDaJornada;
  name: string;
  screen: string | null;
  outcome: string | null;
  durationMs: number | null;
}

/** Campos do aparelho que vieram no payload — só estes sobrescrevem o cadastro. */
export interface CamposDoAparelho {
  brand?: string;
  model?: string;
  modelId?: string;
  osName?: string;
  osVersion?: string;
  deviceType?: string;
  timezone?: string;
}

export interface PlanoDaJornada {
  camposDoAparelho: CamposDoAparelho;
  clientIp: string | null;
  /** Último `auth_login_success` / `auth_logout` da jornada, se houver. */
  loginEm: Date | null;
  logoutEm: Date | null;
  eventos: EventoDaJornada[];
}

/** Tudo o que a ingestão de um summary grava, já calculado. */
export interface PlanoDeIngestao {
  chave: ChaveDoDia;
  recibo: ReciboDoResumo;
  installHash: string;
  sessionHash: string;
  analyticsUserId: number | null;
  runtimeVersion: string | undefined;
  telas: LinhaDeTela[];
  acoes: LinhaDeAcao[];
  formularios: LinhaDeFormulario[];
  jornada: PlanoDaJornada | null;
}

const TIPO_DO_EVENTO: Record<
  SanitizedJourneyEvent['type'],
  TipoDeEventoDaJornada
> = {
  screen: 'SCREEN',
  action: 'ACTION',
  form: 'FORM',
};

const emOrdem = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Uma linha por tela, somando as repetidas dentro do summary, em ordem de
 * chave. A soma é a mesma que os upserts em sequência produziam; a ordem
 * fixa faz dois lotes concorrentes travarem as linhas na mesma sequência.
 */
export function linhasDeTela(
  telas: ResumoSanitizado['screens'],
): LinhaDeTela[] {
  const porTela = new Map<string, LinhaDeTela>();
  for (const tela of telas) {
    const linha = porTela.get(tela.screen) ?? {
      screen: tela.screen,
      viewCount: 0,
      totalTimeMs: 0,
    };
    linha.viewCount += tela.view_count;
    linha.totalTimeMs += tela.total_time_ms;
    porTela.set(tela.screen, linha);
  }
  return [...porTela.values()].sort((a, b) => emOrdem(a.screen, b.screen));
}

/** Uma linha por ação, somando as repetidas, em ordem de chave. */
export function linhasDeAcao(
  acoes: ResumoSanitizado['actions'],
): LinhaDeAcao[] {
  const porAcao = new Map<string, LinhaDeAcao>();
  for (const acao of acoes) {
    const linha = porAcao.get(acao.action) ?? { action: acao.action, count: 0 };
    linha.count += acao.count;
    porAcao.set(acao.action, linha);
  }
  return [...porAcao.values()].sort((a, b) => emOrdem(a.action, b.action));
}

/** Uma linha por tela+formulário, somando as repetidas, em ordem de chave. */
export function linhasDeFormulario(
  formularios: ResumoSanitizado['forms'],
): LinhaDeFormulario[] {
  const porChave = new Map<string, LinhaDeFormulario>();
  for (const f of formularios) {
    // Separador que não aparece em identificador de tela/formulário.
    const chave = `${f.screen}\u0000${f.form}`;
    const linha = porChave.get(chave) ?? {
      screen: f.screen,
      form: f.form,
      startedCount: 0,
      submittedCount: 0,
      successCount: 0,
      errorCount: 0,
    };
    linha.startedCount += f.started_count;
    linha.submittedCount += f.submitted_count;
    linha.successCount += f.success_count;
    linha.errorCount += f.error_count;
    porChave.set(chave, linha);
  }
  return [...porChave.values()].sort(
    (a, b) => emOrdem(a.screen, b.screen) || emOrdem(a.form, b.form),
  );
}

/**
 * Quanto somar em `AnalyticsSessionDaily` para este summary: 1 sessão se a
 * sessão ainda não tinha sido vista no dia, 1 instalação idem. `null` quando
 * as duas já estavam contadas — a linha do dia nem é tocada.
 */
export function incrementoDaSessaoDiaria(visto: {
  sessaoNovaNoDia: boolean;
  instalacaoNovaNoDia: boolean;
}): { sessionsCount: number; installsCount: number } | null {
  if (!visto.sessaoNovaNoDia && !visto.instalacaoNovaNoDia) return null;
  return {
    sessionsCount: visto.sessaoNovaNoDia ? 1 : 0,
    installsCount: visto.instalacaoNovaNoDia ? 1 : 0,
  };
}

/** Horário do último evento de ação `acao` na jornada, ou `null`. */
export function ultimoHorarioDaAcao(
  eventos: readonly SanitizedJourneyEvent[],
  acao: string,
): Date | null {
  let ultimo: number | null = null;
  for (const evento of eventos) {
    if (evento.type !== 'action' || evento.event !== acao) continue;
    const instante = new Date(evento.t).getTime();
    if (ultimo === null || instante > ultimo) ultimo = instante;
  }
  return ultimo === null ? null : new Date(ultimo);
}

function camposDoAparelho(
  device: SanitizedDeviceInfo | null,
): CamposDoAparelho {
  return {
    brand: device?.brand ?? undefined,
    model: device?.model ?? undefined,
    modelId: device?.model_id ?? undefined,
    osName: device?.os_name ?? undefined,
    osVersion: device?.os_version ?? undefined,
    deviceType: device?.device_type ?? undefined,
    timezone: device?.timezone ?? undefined,
  };
}

/**
 * Jornada pronta para gravar: login/logout são inferidos das ações
 * `auth_login_success`/`auth_logout` da própria jornada, e cada evento leva
 * a sua posição (`seq`) na ordem em que chegou — já ordenada por horário.
 */
export function montarPlanoDaJornada(jornada: JornadaDoResumo): PlanoDaJornada {
  return {
    camposDoAparelho: camposDoAparelho(jornada.device),
    clientIp: jornada.clientIp,
    loginEm: ultimoHorarioDaAcao(jornada.events, JOURNEY_LOGIN_ACTION),
    logoutEm: ultimoHorarioDaAcao(jornada.events, JOURNEY_LOGOUT_ACTION),
    eventos: jornada.events.map((evento, seq) => ({
      occurredAt: new Date(evento.t),
      seq,
      eventType: TIPO_DO_EVENTO[evento.type],
      name: evento.event,
      screen: evento.screen,
      outcome: evento.outcome,
      durationMs: evento.duration_ms,
    })),
  };
}

/** Do payload do job para tudo o que a ingestão grava. */
export function montarPlanoDeIngestao(dados: DadosDoResumo): PlanoDeIngestao {
  const { sanitizedPayload: resumo } = dados;

  const appVersion =
    sanitizeVersionString(resumo.app_version) ?? resumo.app_version;
  const runtimeVersion = sanitizeVersionString(resumo.runtime_version);
  const periodStart = new Date(resumo.period_start);
  const periodEnd = new Date(resumo.period_end);
  const analyticsUserId = dados.analyticsUserId ?? null;

  return {
    // Dia de negócio no fuso de São Paulo. O corte antigo (meia-noite UTC =
    // 21h em Brasília) dividia o pico noturno de uso entre dois dias.
    chave: {
      dia: saoPauloDay(periodStart),
      plataforma: resumo.platform,
      appVersion,
    },
    recibo: {
      periodStart,
      periodEnd,
      platform: resumo.platform,
      appVersion,
      runtimeVersion,
      installHash: dados.installHash,
      sessionHash: dados.sessionHash,
      acceptedScreensCount: dados.acceptedScreensCount,
      acceptedActionsCount: dados.acceptedActionsCount,
      acceptedFormsCount: dados.acceptedFormsCount,
      discardedItemsCount: dados.discardedItemsCount,
      validationStatus: dados.discardedItemsCount > 0 ? 'PARTIAL' : 'ACCEPTED',
      payloadHash: dados.payloadHash,
      analyticsUserId,
      journeyEventsCount: dados.journey?.events.length ?? 0,
    },
    installHash: dados.installHash,
    sessionHash: dados.sessionHash,
    analyticsUserId,
    runtimeVersion,
    telas: linhasDeTela(resumo.screens),
    acoes: linhasDeAcao(resumo.actions),
    formularios: linhasDeFormulario(resumo.forms),
    jornada: dados.journey ? montarPlanoDaJornada(dados.journey) : null,
  };
}

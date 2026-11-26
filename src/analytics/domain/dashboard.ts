/**
 * Regras de leitura dos dashboards (funções puras): intervalo de consulta e
 * a consolidação das linhas diárias em totais, rankings e taxas. As queries
 * ficam no `AnalyticsDashboardRepository`.
 */

const DIA_MS = 24 * 60 * 60 * 1000;
/** Sem `from`, a consulta cobre os 30 dias que terminam em `to`. */
const INTERVALO_PADRAO_MS = 30 * DIA_MS;
/** 12 meses, com folga para ano bissexto. */
const INTERVALO_MAXIMO_MS = 366 * DIA_MS;
/** Itens nos rankings do overview. */
const TAMANHO_DO_RANKING = 10;

export interface IntervaloDeConsulta {
  from: Date;
  to: Date;
}

export type IntervaloInvalido =
  | 'FROM_DEPOIS_DE_TO'
  | 'INTERVALO_MAIOR_QUE_O_LIMITE';

/** Mensagem devolvida ao painel (HTTP 422) para cada recusa do intervalo. */
export const MENSAGEM_DE_INTERVALO_INVALIDO: Record<IntervaloInvalido, string> =
  {
    FROM_DEPOIS_DE_TO: '"from" deve ser anterior a "to"',
    INTERVALO_MAIOR_QUE_O_LIMITE: 'Intervalo máximo de consulta é 12 meses',
  };

export function resolverIntervalo(
  consulta: { from?: string; to?: string },
  agora: Date,
): IntervaloDeConsulta | IntervaloInvalido {
  const to = consulta.to ? new Date(consulta.to) : agora;
  const from = consulta.from
    ? new Date(consulta.from)
    : new Date(to.getTime() - INTERVALO_PADRAO_MS);

  if (from > to) return 'FROM_DEPOIS_DE_TO';
  if (to.getTime() - from.getTime() > INTERVALO_MAXIMO_MS) {
    return 'INTERVALO_MAIOR_QUE_O_LIMITE';
  }
  return { from, to };
}

// ─────────────────────────────────────────────────────────────────────────
// Telas, ações e formulários
// ─────────────────────────────────────────────────────────────────────────

export interface LinhaDiariaDeTela {
  screen: string;
  viewCount: number;
  totalTimeMs: number;
}

export interface TelaNoRanking extends LinhaDiariaDeTela {
  avgTimeMs: number;
}

/** Soma as linhas diárias por tela e ordena por visualizações. */
export function rankingDeTelas(
  linhas: readonly LinhaDiariaDeTela[],
): TelaNoRanking[] {
  const porTela = new Map<string, { viewCount: number; totalTimeMs: number }>();
  for (const linha of linhas) {
    const atual = porTela.get(linha.screen) ?? { viewCount: 0, totalTimeMs: 0 };
    porTela.set(linha.screen, {
      viewCount: atual.viewCount + linha.viewCount,
      totalTimeMs: atual.totalTimeMs + linha.totalTimeMs,
    });
  }

  return Array.from(porTela.entries())
    .sort((a, b) => b[1].viewCount - a[1].viewCount)
    .map(([screen, { viewCount, totalTimeMs }]) => ({
      screen,
      viewCount,
      totalTimeMs,
      avgTimeMs: viewCount > 0 ? Math.round(totalTimeMs / viewCount) : 0,
    }));
}

export interface LinhaDiariaDeAcao {
  action: string;
  count: number;
}

/** Total do período por ação. */
export function totalPorAcao(
  linhas: readonly LinhaDiariaDeAcao[],
): Map<string, number> {
  const porAcao = new Map<string, number>();
  for (const linha of linhas) {
    porAcao.set(linha.action, (porAcao.get(linha.action) ?? 0) + linha.count);
  }
  return porAcao;
}

/** Ações da mais frequente para a menos. */
export function rankingDeAcoes(
  totais: ReadonlyMap<string, number>,
): LinhaDiariaDeAcao[] {
  return Array.from(totais.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([action, count]) => ({ action, count }));
}

export interface LinhaDiariaDeFormulario {
  screen: string;
  form: string;
  startedCount: number;
  submittedCount: number;
  successCount: number;
  errorCount: number;
}

const taxa = (parte: number, total: number) =>
  total > 0 ? Number(((parte / total) * 100).toFixed(2)) : 0;

/** Soma por tela+formulário, com as taxas de sucesso e erro sobre os envios. */
export function resumoDeFormularios(
  linhas: readonly LinhaDiariaDeFormulario[],
) {
  type Soma = Omit<LinhaDiariaDeFormulario, 'screen' | 'form'>;
  const porChave = new Map<string, Soma>();
  for (const linha of linhas) {
    const chave = `${linha.screen}::${linha.form}`;
    const atual = porChave.get(chave) ?? {
      startedCount: 0,
      submittedCount: 0,
      successCount: 0,
      errorCount: 0,
    };
    porChave.set(chave, {
      startedCount: atual.startedCount + linha.startedCount,
      submittedCount: atual.submittedCount + linha.submittedCount,
      successCount: atual.successCount + linha.successCount,
      errorCount: atual.errorCount + linha.errorCount,
    });
  }

  return Array.from(porChave.entries()).map(([chave, soma]) => {
    const [screen, form] = chave.split('::');
    return {
      screen,
      form,
      ...soma,
      successRate: taxa(soma.successCount, soma.submittedCount),
      errorRate: taxa(soma.errorCount, soma.submittedCount),
    };
  });
}

/** Visão geral: totais de sessões e das ações principais, e os dois rankings. */
export function montarOverview(lido: {
  sessoes: { sessionsCount: number | null; installsCount: number | null };
  acoes: readonly LinhaDiariaDeAcao[];
  telas: readonly LinhaDiariaDeTela[];
}) {
  const acoes = totalPorAcao(lido.acoes);
  const total = (acao: string) => acoes.get(acao) ?? 0;

  return {
    totalSessions: lido.sessoes.sessionsCount ?? 0,
    totalInstalls: lido.sessoes.installsCount ?? 0,
    totalLoginSuccess: total('auth_login_success'),
    totalLoginError: total('auth_login_error'),
    totalLogout: total('auth_logout'),
    totalBiometricSuccess: total('auth_biometric_success'),
    totalBiometricError: total('auth_biometric_error'),
    totalCouponRedeemSuccess: total('coupon_redeem_success'),
    totalCouponRedeemError: total('coupon_redeem_error'),
    totalInspectionStarted: total('inspection_started'),
    totalInspectionSubmitted: total('inspection_submitted'),
    totalInspectionError: total('inspection_error'),
    totalSosPhoneTriggered: total('sos_phone_triggered'),
    totalSosWhatsappTriggered: total('sos_whatsapp_triggered'),
    // O corte acontece DEPOIS da soma do período: cortar as linhas diárias
    // antes podia omitir telas consistentemente populares do ranking.
    topScreens: rankingDeTelas(lido.telas).slice(0, TAMANHO_DO_RANKING),
    topActions: rankingDeAcoes(acoes).slice(0, TAMANHO_DO_RANKING),
  };
}

const diaIso = (data: Date) => data.toISOString().slice(0, 10);

/** Série diária de sessões e instalações, com o dia em `AAAA-MM-DD`. */
export function serieDeSessoes(
  linhas: ReadonlyArray<{
    day: Date;
    platform: string;
    appVersion: string;
    sessionsCount: number;
    installsCount: number;
  }>,
) {
  return linhas.map((linha) => ({
    day: diaIso(linha.day),
    platform: linha.platform,
    appVersion: linha.appVersion,
    sessionsCount: linha.sessionsCount,
    installsCount: linha.installsCount,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Audiência
// ─────────────────────────────────────────────────────────────────────────

export interface JanelasDaAudiencia {
  /** Período consultado, na granularidade de dia (coluna `DATE` em UTC). */
  dayFrom: Date;
  dayTo: Date;
  /** Dias corridos do período, contando as duas pontas. */
  days: number;
  /** Início das janelas fixas de 7 e 30 dias que terminam em `dayTo`. */
  wauFrom: Date;
  mauFrom: Date;
}

export function janelasDaAudiencia(
  intervalo: IntervaloDeConsulta,
): JanelasDaAudiencia {
  const dayFrom = new Date(`${diaIso(intervalo.from)}T00:00:00.000Z`);
  const dayTo = new Date(`${diaIso(intervalo.to)}T00:00:00.000Z`);
  return {
    dayFrom,
    dayTo,
    days: Math.floor((dayTo.getTime() - dayFrom.getTime()) / DIA_MS) + 1,
    wauFrom: new Date(dayTo.getTime() - 6 * DIA_MS),
    mauFrom: new Date(dayTo.getTime() - 29 * DIA_MS),
  };
}

export interface LinhasDaAudiencia {
  aparelhos: ReadonlyArray<{
    platform: string;
    uniqueDevices: bigint;
    deviceDays: bigint;
    wau: bigint;
    mau: bigint;
  }>;
  sessoes: ReadonlyArray<{ platform: string; uniqueSessions: bigint }>;
  novos: ReadonlyArray<{ platform: string; newDevices: bigint }>;
  novosPorDia: ReadonlyArray<{ day: Date; platform: string; count: bigint }>;
}

const razao = (parte: number, total: number) =>
  total > 0 ? Number((parte / total).toFixed(2)) : 0;

/**
 * Métricas de audiência a partir das contagens por plataforma.
 *
 * Semântica de cada número:
 *  - uniqueDevices:  aparelhos distintos no período — cada um conta UMA vez,
 *    não importa em quantos dias apareceu;
 *  - uniqueSessions: idem para sessões (dedup entre dias e versões);
 *  - deviceDays:     linhas de aparelho-dia — mede frequência, não base;
 *  - newDevices:     aparelhos cuja PRIMEIRA aparição histórica cai no
 *    período — aquisição real;
 *  - avgDailyDevices (DAU): deviceDays ÷ dias corridos do período;
 *  - wau / mau:      aparelhos únicos nos 7 / 30 dias que terminam em `to`
 *    (janelas fixas, independentes do tamanho do período consultado);
 *  - stickiness:     DAU ÷ MAU × 100 — % da base mensal que volta num dia.
 */
export function montarAudiencia(
  janelas: JanelasDaAudiencia,
  linhas: LinhasDaAudiencia,
) {
  const { days } = janelas;
  const sessoesPorPlataforma = new Map(
    linhas.sessoes.map((r) => [r.platform, Number(r.uniqueSessions)]),
  );
  const novosPorPlataforma = new Map(
    linhas.novos.map((r) => [r.platform, Number(r.newDevices)]),
  );

  const platforms = linhas.aparelhos
    .map((linha) => {
      const uniqueDevices = Number(linha.uniqueDevices);
      const deviceDays = Number(linha.deviceDays);
      const uniqueSessions = sessoesPorPlataforma.get(linha.platform) ?? 0;
      return {
        platform: linha.platform,
        uniqueDevices,
        uniqueSessions,
        deviceDays,
        newDevices: novosPorPlataforma.get(linha.platform) ?? 0,
        avgDailyDevices: razao(deviceDays, days),
        sessionsPerDevice: razao(uniqueSessions, uniqueDevices),
        avgActiveDaysPerDevice: razao(deviceDays, uniqueDevices),
      };
    })
    .sort((a, b) => b.uniqueDevices - a.uniqueDevices);

  // Um installHash pertence a uma única plataforma, então a soma dos
  // distintos por plataforma É o distinto global — não há dupla contagem.
  const totals = platforms.reduce(
    (acc, p) => ({
      uniqueDevices: acc.uniqueDevices + p.uniqueDevices,
      uniqueSessions: acc.uniqueSessions + p.uniqueSessions,
      deviceDays: acc.deviceDays + p.deviceDays,
      newDevices: acc.newDevices + p.newDevices,
    }),
    { uniqueDevices: 0, uniqueSessions: 0, deviceDays: 0, newDevices: 0 },
  );

  const wau = linhas.aparelhos.reduce((acc, r) => acc + Number(r.wau), 0);
  const mau = linhas.aparelhos.reduce((acc, r) => acc + Number(r.mau), 0);
  const avgDailyDevices = razao(totals.deviceDays, days);

  return {
    from: diaIso(janelas.dayFrom),
    to: diaIso(janelas.dayTo),
    days,
    totals: {
      ...totals,
      avgDailyDevices,
      wau,
      mau,
      stickiness:
        mau > 0 ? Number(((avgDailyDevices / mau) * 100).toFixed(2)) : 0,
    },
    platforms,
    newDevicesDaily: linhas.novosPorDia.map((r) => ({
      day: diaIso(r.day),
      platform: r.platform,
      count: Number(r.count),
    })),
  };
}

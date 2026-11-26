import { PrismaClient } from '@prisma/client';
import { Job } from 'bullmq';
import { DadosDoResumo } from 'src/analytics/domain/agregados-diarios';
import { AnalyticsIngestProcessor } from 'src/analytics/processors/analytics-ingest.processor';
import { AnalyticsDashboardRepository } from 'src/analytics/repositories/analytics-dashboard.repository';
import { AnalyticsIngestaoRepository } from 'src/analytics/repositories/analytics-ingestao.repository';
import { AnalyticsAplicarResumoService } from 'src/analytics/services/analytics-aplicar-resumo.service';
import { AnalyticsDashboardService } from 'src/analytics/services/analytics-dashboard.service';
import { AnalyticsJornadaExpurgoService } from 'src/analytics/services/analytics-jornada-expurgo.service';
import { saoPauloDay } from 'src/analytics/utils/analytics-day.util';
import { PrismaService } from 'src/database/prisma.service';
import { metricas } from 'src/infra/observability/metricas';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ANALYTICS_QUEUE } from 'src/queue/filas';
import { TEST_DATABASE_URL, describeComBanco } from './ambiente';

const MARCA = `it-an-${process.pid}`;
/** Duas versões do app: a versão é dimensão dos agregados (cabe em 20). */
const V1 = `${MARCA}-a`.slice(0, 20);
const V2 = `${MARCA}-b`.slice(0, 20);
const USUARIO = 900_000_000 + (process.pid % 100_000);

const D1 = '2001-06-10';
const D2 = '2001-06-11';

type Resumo = DadosDoResumo;
type Tela = Resumo['sanitizedPayload']['screens'][number];
type Acao = Resumo['sanitizedPayload']['actions'][number];
type Formulario = Resumo['sanitizedPayload']['forms'][number];

let sequencia = 0;

/** Monta o payload do job como o `AnalyticsService.ingest` o enfileira. */
function resumo(opcoes: {
  inicio: string;
  install: string;
  sessao: string;
  plataforma?: 'android' | 'ios';
  versao?: string;
  telas?: Tela[];
  acoes?: Acao[];
  formularios?: Formulario[];
  usuario?: number | null;
  jornada?: Resumo['journey'];
  descartados?: number;
}): Resumo {
  sequencia += 1;
  const inicio = new Date(opcoes.inicio);
  const telas = opcoes.telas ?? [];
  const acoes = opcoes.acoes ?? [];
  const formularios = opcoes.formularios ?? [];
  const installHash = `${MARCA}-${opcoes.install}`;
  const sessionHash = `${MARCA}-${opcoes.sessao}`;
  return {
    sanitizedPayload: {
      period_start: inicio.toISOString(),
      period_end: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
      platform: opcoes.plataforma ?? 'android',
      app_version: opcoes.versao ?? V1,
      runtime_version: '1.0.0',
      install_hash: installHash,
      session_hash: sessionHash,
      screens: telas,
      actions: acoes,
      forms: formularios,
    },
    installHash,
    sessionHash,
    payloadHash: `${MARCA}-p${sequencia}`,
    discardedItemsCount: opcoes.descartados ?? 0,
    acceptedScreensCount: telas.length,
    acceptedActionsCount: acoes.length,
    acceptedFormsCount: formularios.length,
    analyticsUserId: opcoes.usuario ?? null,
    journey: opcoes.jornada,
  };
}

/**
 * Cenário que exercita todos os caminhos dos agregados: criação e soma na
 * mesma chave, tela repetida dentro de um summary, sessão e aparelho já
 * contados no dia, virada do dia no fuso de São Paulo, outra plataforma,
 * outra versão do app e a jornada (com e sem conta).
 */
function cenario(): Resumo[] {
  return [
    // 1. Primeiro summary do aparelho i1 / sessão s1 (12h em Brasília).
    resumo({
      inicio: `${D1}T15:00:00.000Z`,
      install: 'i1',
      sessao: 's1',
      telas: [
        { screen: 'screen_home', view_count: 2, total_time_ms: 5000 },
        { screen: 'screen_login', view_count: 1, total_time_ms: 1000 },
      ],
      acoes: [{ action: 'auth_login_success', count: 1 }],
      formularios: [
        {
          screen: 'screen_login',
          form: 'form_login',
          started_count: 1,
          submitted_count: 1,
          success_count: 1,
          error_count: 0,
        },
      ],
    }),
    // 2. Mesma sessão, meia hora depois: soma nas mesmas chaves.
    resumo({
      inicio: `${D1}T15:30:00.000Z`,
      install: 'i1',
      sessao: 's1',
      descartados: 2,
      telas: [{ screen: 'screen_home', view_count: 3, total_time_ms: 7000 }],
      acoes: [
        { action: 'auth_login_success', count: 2 },
        { action: 'auth_logout', count: 1 },
      ],
      formularios: [
        {
          screen: 'screen_login',
          form: 'form_login',
          started_count: 2,
          submitted_count: 1,
          success_count: 0,
          error_count: 1,
        },
      ],
    }),
    // 3. Sessão nova do mesmo aparelho; a mesma tela vem duas vezes no summary.
    resumo({
      inicio: `${D1}T16:00:00.000Z`,
      install: 'i1',
      sessao: 's2',
      telas: [
        { screen: 'screen_home', view_count: 1, total_time_ms: 100 },
        { screen: 'screen_home', view_count: 4, total_time_ms: 400 },
      ],
    }),
    // 4. Outro aparelho no mesmo dia.
    resumo({
      inicio: `${D1}T17:00:00.000Z`,
      install: 'i2',
      sessao: 's3',
      telas: [{ screen: 'screen_perfil', view_count: 1, total_time_ms: 50 }],
    }),
    // 5. 02h30 UTC do dia seguinte ainda é 23h30 do D1 em Brasília.
    resumo({
      inicio: `${D2}T02:30:00.000Z`,
      install: 'i2',
      sessao: 's3',
      telas: [{ screen: 'screen_perfil', view_count: 2, total_time_ms: 20 }],
    }),
    // 6. A sessão s1 atravessa a meia-noite de Brasília: conta de novo no D2.
    resumo({
      inicio: `${D2}T15:00:00.000Z`,
      install: 'i1',
      sessao: 's1',
      telas: [{ screen: 'screen_home', view_count: 1, total_time_ms: 10 }],
    }),
    // 7. Outra plataforma.
    resumo({
      inicio: `${D1}T15:00:00.000Z`,
      install: 'i3',
      sessao: 's4',
      plataforma: 'ios',
      telas: [{ screen: 'screen_home', view_count: 7, total_time_ms: 70 }],
    }),
    // 8. Aparelho e sessão já contados no dia, agora em outra versão do app:
    //    a tela entra na versão nova; sessão/instalação não contam de novo.
    resumo({
      inicio: `${D1}T18:00:00.000Z`,
      install: 'i1',
      sessao: 's1',
      versao: V2,
      telas: [{ screen: 'screen_home', view_count: 1, total_time_ms: 1 }],
    }),
    // 9. Jornada com conta: aparelho, vínculo e eventos.
    resumo({
      inicio: `${D1}T19:00:00.000Z`,
      install: 'i4',
      sessao: 's5',
      usuario: USUARIO,
      jornada: {
        device: {
          brand: 'Samsung',
          model: 'SM-A155M',
          model_id: null,
          os_name: 'Android',
          os_version: '14',
          device_type: 'phone',
          timezone: 'America/Sao_Paulo',
        },
        clientIp: '10.0.0.5',
        events: [
          {
            t: `${D1}T19:01:00.000Z`,
            type: 'screen',
            event: 'screen_home',
            duration_ms: 3000,
            screen: null,
            outcome: null,
          },
          {
            t: `${D1}T19:02:00.000Z`,
            type: 'action',
            event: 'auth_login_success',
            duration_ms: null,
            screen: null,
            outcome: null,
          },
          {
            t: `${D1}T19:03:00.000Z`,
            type: 'form',
            event: 'form_login',
            duration_ms: null,
            screen: 'screen_login',
            outcome: 'success',
          },
        ],
      },
    }),
    // 10. Flush pós-logout, sem conta: a saída vai para o último vínculo.
    resumo({
      inicio: `${D1}T19:30:00.000Z`,
      install: 'i4',
      sessao: 's5',
      jornada: {
        device: null,
        clientIp: null,
        events: [
          {
            t: `${D1}T19:31:00.000Z`,
            type: 'action',
            event: 'auth_logout',
            duration_ms: null,
            screen: null,
            outcome: null,
          },
        ],
      },
    }),
  ];
}

describeComBanco('Banco real — ingestão dos summaries de analytics', () => {
  let prisma: PrismaService;
  let processor: AnalyticsIngestProcessor;
  let ingestao: AnalyticsIngestaoRepository;

  const marcados = { appVersion: { startsWith: MARCA } };

  async function limpar(): Promise<void> {
    await prisma.analyticsJourneyEvent.deleteMany({ where: marcados });
    await prisma.analyticsUserDevice.deleteMany({
      where: { installHash: { startsWith: MARCA } },
    });
    await prisma.analyticsDevice.deleteMany({
      where: { installHash: { startsWith: MARCA } },
    });
    await prisma.analyticsScreenDaily.deleteMany({ where: marcados });
    await prisma.analyticsActionDaily.deleteMany({ where: marcados });
    await prisma.analyticsFormDaily.deleteMany({ where: marcados });
    await prisma.analyticsSessionDaily.deleteMany({ where: marcados });
    await prisma.analyticsDailyUniqueSession.deleteMany({ where: marcados });
    await prisma.analyticsDailyUniqueInstall.deleteMany({ where: marcados });
    await prisma.analyticsInstallFirstSeen.deleteMany({
      where: { installHash: { startsWith: MARCA } },
    });
    await prisma.analyticsSummaryReceipt.deleteMany({
      where: { payloadHash: { startsWith: MARCA } },
    });
  }

  const dia = (data: Date) => data.toISOString().slice(0, 10);
  const curto = (hash: string | null) => hash?.replace(`${MARCA}-`, '') ?? null;
  const versao = (v: string) => (v === V1 ? 'V1' : v === V2 ? 'V2' : v);

  /** Estado final das tabelas, sem ids nem carimbos de "agora". */
  async function estado() {
    const [
      telas,
      acoes,
      formularios,
      sessoesDia,
      sessoesUnicas,
      instalacoesUnicas,
      primeiraVez,
      recibos,
      aparelhos,
      vinculos,
      eventos,
    ] = await Promise.all([
      prisma.analyticsScreenDaily.findMany({ where: marcados }),
      prisma.analyticsActionDaily.findMany({ where: marcados }),
      prisma.analyticsFormDaily.findMany({ where: marcados }),
      prisma.analyticsSessionDaily.findMany({ where: marcados }),
      prisma.analyticsDailyUniqueSession.findMany({ where: marcados }),
      prisma.analyticsDailyUniqueInstall.findMany({ where: marcados }),
      prisma.analyticsInstallFirstSeen.findMany({
        where: { installHash: { startsWith: MARCA } },
      }),
      prisma.analyticsSummaryReceipt.findMany({
        where: { payloadHash: { startsWith: MARCA } },
      }),
      prisma.analyticsDevice.findMany({
        where: { installHash: { startsWith: MARCA } },
      }),
      prisma.analyticsUserDevice.findMany({
        where: { installHash: { startsWith: MARCA } },
      }),
      prisma.analyticsJourneyEvent.findMany({ where: marcados }),
    ]);
    const reciboPorId = new Map(recibos.map((r) => [r.id, r]));

    return {
      telas: telas
        .map(
          (t) =>
            `${dia(t.day)} ${t.platform} ${versao(t.appVersion)} ${t.screen} views=${t.viewCount} ms=${t.totalTimeMs}`,
        )
        .sort(),
      acoes: acoes
        .map(
          (a) =>
            `${dia(a.day)} ${a.platform} ${versao(a.appVersion)} ${a.action} count=${a.count}`,
        )
        .sort(),
      formularios: formularios
        .map(
          (f) =>
            `${dia(f.day)} ${f.platform} ${versao(f.appVersion)} ${f.screen}/${f.form} ` +
            `started=${f.startedCount} submitted=${f.submittedCount} success=${f.successCount} error=${f.errorCount}`,
        )
        .sort(),
      sessoesDia: sessoesDia
        .map(
          (s) =>
            `${dia(s.day)} ${s.platform} ${versao(s.appVersion)} sessions=${s.sessionsCount} installs=${s.installsCount}`,
        )
        .sort(),
      sessoesUnicas: sessoesUnicas
        .map(
          (s) =>
            `${dia(s.day)} ${s.platform} ${versao(s.appVersion)} ${curto(s.sessionHash)}`,
        )
        .sort(),
      instalacoesUnicas: instalacoesUnicas
        .map(
          (i) =>
            `${dia(i.day)} ${i.platform} ${versao(i.appVersion)} ${curto(i.installHash)}`,
        )
        .sort(),
      primeiraVez: primeiraVez
        .map(
          (p) =>
            `${curto(p.installHash)} ${p.platform} ${versao(p.appVersion)} ${dia(p.firstSeenDay)}`,
        )
        .sort(),
      recibos: recibos
        .map(
          (r) =>
            `${curto(r.payloadHash)} ${r.platform} ${versao(r.appVersion)} rt=${r.runtimeVersion} ` +
            `${curto(r.installHash)}/${curto(r.sessionHash)} ${r.periodStart.toISOString()}..${r.periodEnd.toISOString()} ` +
            `aceitos=${r.acceptedScreensCount}/${r.acceptedActionsCount}/${r.acceptedFormsCount} ` +
            `descartados=${r.discardedItemsCount} ${r.validationStatus} user=${r.analyticsUserId} jornada=${r.journeyEventsCount}`,
        )
        .sort(),
      aparelhos: aparelhos
        .map((a) => ({
          install: curto(a.installHash),
          platform: a.platform,
          brand: a.brand,
          model: a.model,
          modelId: a.modelId,
          osName: a.osName,
          osVersion: a.osVersion,
          deviceType: a.deviceType,
          timezone: a.timezone,
          appVersion: versao(a.appVersion),
          runtimeVersion: a.runtimeVersion,
          lastSession: curto(a.lastSessionHash),
          lastUserId: a.lastUserId,
          lastIp: a.lastIp,
          summariesCount: a.summariesCount,
        }))
        .sort((x, y) => String(x.install).localeCompare(String(y.install))),
      vinculos: vinculos
        .map((v) => ({
          userId: v.userId,
          install: curto(v.installHash),
          platform: v.platform,
          lastAppVersion: versao(v.lastAppVersion),
          lastSession: curto(v.lastSessionHash),
          summariesCount: v.summariesCount,
          lastLoginAt: v.lastLoginAt?.toISOString() ?? null,
          lastLogoutAt: v.lastLogoutAt?.toISOString() ?? null,
        }))
        .sort((x, y) => String(x.install).localeCompare(String(y.install))),
      eventos: eventos
        .map((e) => {
          const recibo = e.receiptId ? reciboPorId.get(e.receiptId) : undefined;
          return (
            `${curto(recibo?.payloadHash ?? null)}#${e.seq} ${e.occurredAt.toISOString()} ${e.eventType} ${e.name} ` +
            `screen=${e.screen} outcome=${e.outcome} ms=${e.durationMs} user=${e.userId} ` +
            `${curto(e.installHash)}/${curto(e.sessionHash)} ${e.platform} ${versao(e.appVersion)} ` +
            `recebidoComORecibo=${recibo ? e.receivedAt.getTime() === recibo.receivedAt.getTime() : false}`
          );
        })
        .sort(),
    };
  }

  /** Valores calculados à mão para o `cenario()`. */
  const ESPERADO = {
    telas: [
      `${D1} android V1 screen_home views=10 ms=12500`,
      `${D1} android V1 screen_login views=1 ms=1000`,
      `${D1} android V1 screen_perfil views=3 ms=70`,
      `${D1} android V2 screen_home views=1 ms=1`,
      `${D1} ios V1 screen_home views=7 ms=70`,
      `${D2} android V1 screen_home views=1 ms=10`,
    ],
    acoes: [
      `${D1} android V1 auth_login_success count=3`,
      `${D1} android V1 auth_logout count=1`,
    ],
    formularios: [
      `${D1} android V1 screen_login/form_login started=3 submitted=2 success=1 error=1`,
    ],
    sessoesDia: [
      // s1, s2, s3, s5 | i1, i2, i4
      `${D1} android V1 sessions=4 installs=3`,
      `${D1} ios V1 sessions=1 installs=1`,
      `${D2} android V1 sessions=1 installs=1`,
    ],
    sessoesUnicas: [
      `${D1} android V1 s1`,
      `${D1} android V1 s2`,
      `${D1} android V1 s3`,
      `${D1} android V1 s5`,
      `${D1} ios V1 s4`,
      `${D2} android V1 s1`,
    ],
    instalacoesUnicas: [
      `${D1} android V1 i1`,
      `${D1} android V1 i2`,
      `${D1} android V1 i4`,
      `${D1} ios V1 i3`,
      `${D2} android V1 i1`,
    ],
    primeiraVez: [
      `i1 android V1 ${D1}`,
      `i2 android V1 ${D1}`,
      `i3 ios V1 ${D1}`,
      `i4 android V1 ${D1}`,
    ],
  };

  const job = (dados: Resumo, id: string): Job<Resumo> =>
    ({
      id,
      name: 'process-summary',
      queueName: ANALYTICS_QUEUE,
      data: dados,
      opts: {},
      attemptsMade: 0,
    }) as unknown as Job<Resumo>;

  /** Caminho novo: o processor de verdade, com os serviços de verdade. */
  const aplicar = async (dados: Resumo[]) => {
    const resultados: unknown[] = [];
    for (const [i, d] of dados.entries()) {
      resultados.push(await processor.process(job(d, `${MARCA}-${i}`)));
    }
    return resultados;
  };

  /**
   * Caminho ANTIGO, guardado aqui como referência: a ingestão como era antes
   * do lote — um `upsert` do Prisma por linha de agregado, em sequência, e
   * `catch {}` nas tabelas de unicidade. É contra ele que o caminho novo é
   * comparado.
   */
  const aplicarPeloCaminhoAntigo = async (lista: Resumo[]): Promise<void> => {
    for (const dados of lista) {
      const { sanitizedPayload: r, installHash, sessionHash, journey } = dados;
      const platform = r.platform;
      const appVersion = r.app_version.trim().slice(0, 20);
      const runtimeVersion = r.runtime_version?.trim().slice(0, 20);
      const periodStart = new Date(r.period_start);
      const day = saoPauloDay(periodStart);
      const analyticsUserId = dados.analyticsUserId ?? null;

      await prisma.$transaction(async (tx) => {
        const receipt = await tx.analyticsSummaryReceipt.create({
          data: {
            periodStart,
            periodEnd: new Date(r.period_end),
            platform,
            appVersion,
            runtimeVersion,
            installHash,
            sessionHash,
            acceptedScreensCount: dados.acceptedScreensCount,
            acceptedActionsCount: dados.acceptedActionsCount,
            acceptedFormsCount: dados.acceptedFormsCount,
            discardedItemsCount: dados.discardedItemsCount,
            validationStatus:
              dados.discardedItemsCount > 0 ? 'PARTIAL' : 'ACCEPTED',
            payloadHash: dados.payloadHash,
            analyticsUserId,
            journeyEventsCount: journey?.events.length ?? 0,
          },
          select: { id: true, receivedAt: true },
        });

        let sessionIsNew = false;
        try {
          await tx.analyticsDailyUniqueSession.create({
            data: { day, platform, appVersion, sessionHash },
          });
          sessionIsNew = true;
        } catch {
          // já contabilizada
        }
        let installIsNew = false;
        try {
          await tx.analyticsDailyUniqueInstall.create({
            data: { day, platform, appVersion, installHash },
          });
          installIsNew = true;
        } catch {
          // já contabilizada
        }
        if (installIsNew) {
          try {
            await tx.analyticsInstallFirstSeen.create({
              data: { installHash, platform, appVersion, firstSeenDay: day },
            });
          } catch {
            // aparelho já conhecido
          }
        }

        if (sessionIsNew || installIsNew) {
          await tx.analyticsSessionDaily.upsert({
            where: { day_platform_appVersion: { day, platform, appVersion } },
            create: {
              day,
              platform,
              appVersion,
              sessionsCount: sessionIsNew ? 1 : 0,
              installsCount: installIsNew ? 1 : 0,
            },
            update: {
              sessionsCount: { increment: sessionIsNew ? 1 : 0 },
              installsCount: { increment: installIsNew ? 1 : 0 },
            },
          });
        }

        for (const screen of r.screens) {
          await tx.analyticsScreenDaily.upsert({
            where: {
              day_platform_appVersion_screen: {
                day,
                platform,
                appVersion,
                screen: screen.screen,
              },
            },
            create: {
              day,
              platform,
              appVersion,
              screen: screen.screen,
              viewCount: screen.view_count,
              totalTimeMs: screen.total_time_ms,
            },
            update: {
              viewCount: { increment: screen.view_count },
              totalTimeMs: { increment: screen.total_time_ms },
            },
          });
        }

        for (const action of r.actions) {
          await tx.analyticsActionDaily.upsert({
            where: {
              day_platform_appVersion_action: {
                day,
                platform,
                appVersion,
                action: action.action,
              },
            },
            create: {
              day,
              platform,
              appVersion,
              action: action.action,
              count: action.count,
            },
            update: { count: { increment: action.count } },
          });
        }

        if (journey) {
          const ultimo = (acao: string) => {
            const horarios = journey.events
              .filter((e) => e.type === 'action' && e.event === acao)
              .map((e) => new Date(e.t).getTime());
            return horarios.length ? new Date(Math.max(...horarios)) : null;
          };
          const loginAt = ultimo('auth_login_success');
          const logoutAt = ultimo('auth_logout');
          const device = journey.device;
          const deviceFields = {
            brand: device?.brand ?? undefined,
            model: device?.model ?? undefined,
            modelId: device?.model_id ?? undefined,
            osName: device?.os_name ?? undefined,
            osVersion: device?.os_version ?? undefined,
            deviceType: device?.device_type ?? undefined,
            timezone: device?.timezone ?? undefined,
          };
          const existingDevice = await tx.analyticsDevice.upsert({
            where: { installHash },
            create: {
              installHash,
              platform,
              appVersion,
              runtimeVersion: runtimeVersion ?? null,
              lastSessionHash: sessionHash,
              lastUserId: analyticsUserId,
              lastIp: journey.clientIp,
              summariesCount: 1,
              firstSeenAt: receipt.receivedAt,
              lastSeenAt: receipt.receivedAt,
              ...deviceFields,
            },
            update: {
              platform,
              appVersion,
              runtimeVersion: runtimeVersion ?? undefined,
              lastSessionHash: sessionHash,
              lastUserId: analyticsUserId ?? undefined,
              lastIp: journey.clientIp ?? undefined,
              summariesCount: { increment: 1 },
              lastSeenAt: receipt.receivedAt,
              ...deviceFields,
            },
            select: { lastUserId: true },
          });
          if (analyticsUserId !== null) {
            await tx.analyticsUserDevice.upsert({
              where: {
                userId_installHash: { userId: analyticsUserId, installHash },
              },
              create: {
                userId: analyticsUserId,
                installHash,
                platform,
                lastAppVersion: appVersion,
                lastSessionHash: sessionHash,
                summariesCount: 1,
                firstSeenAt: receipt.receivedAt,
                lastSeenAt: receipt.receivedAt,
                lastLoginAt: loginAt,
                lastLogoutAt: logoutAt,
              },
              update: {
                platform,
                lastAppVersion: appVersion,
                lastSessionHash: sessionHash,
                summariesCount: { increment: 1 },
                lastSeenAt: receipt.receivedAt,
                lastLoginAt: loginAt ?? undefined,
                lastLogoutAt: logoutAt ?? undefined,
              },
            });
          } else if (logoutAt && existingDevice.lastUserId !== null) {
            await tx.analyticsUserDevice.updateMany({
              where: { userId: existingDevice.lastUserId, installHash },
              data: { lastLogoutAt: logoutAt },
            });
          }
          if (journey.events.length > 0) {
            const tipo = {
              screen: 'SCREEN',
              action: 'ACTION',
              form: 'FORM',
            } as const;
            await tx.analyticsJourneyEvent.createMany({
              data: journey.events.map((event, seq) => ({
                occurredAt: new Date(event.t),
                receivedAt: receipt.receivedAt,
                receiptId: receipt.id,
                userId: analyticsUserId,
                installHash,
                sessionHash,
                platform,
                appVersion,
                seq,
                eventType: tipo[event.type],
                name: event.event,
                screen: event.screen,
                outcome: event.outcome,
                durationMs: event.duration_ms,
              })),
            });
          }
        }

        for (const form of r.forms) {
          await tx.analyticsFormDaily.upsert({
            where: {
              day_platform_appVersion_screen_form: {
                day,
                platform,
                appVersion,
                screen: form.screen,
                form: form.form,
              },
            },
            create: {
              day,
              platform,
              appVersion,
              screen: form.screen,
              form: form.form,
              startedCount: form.started_count,
              submittedCount: form.submitted_count,
              successCount: form.success_count,
              errorCount: form.error_count,
            },
            update: {
              startedCount: { increment: form.started_count },
              submittedCount: { increment: form.submitted_count },
              successCount: { increment: form.success_count },
              errorCount: { increment: form.error_count },
            },
          });
        }
      });
    }
  };

  /**
   * Lote pseudoaleatório (semente fixa): muitos summaries pequenos caindo
   * nas mesmas chaves, com repetição dentro do summary, em 3 dias, 2
   * plataformas e 2 versões.
   */
  function loteAleatorio(quantos: number, semente: number): Resumo[] {
    let estado = semente >>> 0;
    const sorteio = (limite: number) => {
      estado = (Math.imul(estado, 1664525) + 1013904223) >>> 0;
      return estado % limite;
    };
    const telas = [
      'screen_home',
      'screen_login',
      'screen_perfil',
      'screen_sos',
    ];
    const acoes = ['auth_login_success', 'auth_logout', 'boleto_copied'];
    const telasDeForm = ['screen_login', 'screen_trocar_senha'];
    const formularios = ['form_login', 'form_trocar_senha'];
    const dias = ['2001-06-10', '2001-06-11', '2001-06-12'];

    return Array.from({ length: quantos }, () =>
      resumo({
        inicio: `${dias[sorteio(3)]}T${String(3 + sorteio(21)).padStart(2, '0')}:${sorteio(2) ? '00' : '30'}:00.000Z`,
        install: `r-i${sorteio(6)}`,
        sessao: `r-s${sorteio(12)}`,
        plataforma: sorteio(4) === 0 ? 'ios' : 'android',
        versao: sorteio(5) === 0 ? V2 : V1,
        telas: Array.from({ length: sorteio(6) }, () => ({
          screen: telas[sorteio(telas.length)],
          view_count: sorteio(50),
          total_time_ms: sorteio(100_000),
        })),
        acoes: Array.from({ length: sorteio(5) }, () => ({
          action: acoes[sorteio(acoes.length)],
          count: sorteio(20),
        })),
        formularios: Array.from({ length: sorteio(3) }, () => ({
          screen: telasDeForm[sorteio(2)],
          form: formularios[sorteio(2)],
          started_count: sorteio(9),
          submitted_count: sorteio(9),
          success_count: sorteio(9),
          error_count: sorteio(9),
        })),
      }),
    );
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    ingestao = new AnalyticsIngestaoRepository(prisma);
    processor = new AnalyticsIngestProcessor(
      new AnalyticsAplicarResumoService(ingestao),
      new AnalyticsJornadaExpurgoService(prisma),
      { receber: jest.fn() } as unknown as FilaDeMortosService,
    );
  });

  afterAll(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    sequencia = 0;
    await limpar();
  });

  it('estado final das tabelas para o cenário completo (valores calculados à mão)', async () => {
    await aplicar(cenario());

    const final = await estado();

    expect(final).toMatchObject(ESPERADO);
    expect(final.recibos).toHaveLength(10);
    expect(final.recibos[0]).toBe(
      `p1 android V1 rt=1.0.0 i1/s1 ${D1}T15:00:00.000Z..${D1}T15:30:00.000Z ` +
        'aceitos=2/1/1 descartados=0 ACCEPTED user=null jornada=0',
    );
    expect(final.recibos).toContain(
      `p2 android V1 rt=1.0.0 i1/s1 ${D1}T15:30:00.000Z..${D1}T16:00:00.000Z ` +
        'aceitos=1/2/1 descartados=2 PARTIAL user=null jornada=0',
    );
    expect(final.aparelhos).toEqual([
      {
        install: 'i4',
        platform: 'android',
        brand: 'Samsung',
        model: 'SM-A155M',
        modelId: null,
        osName: 'Android',
        osVersion: '14',
        deviceType: 'phone',
        timezone: 'America/Sao_Paulo',
        appVersion: 'V1',
        runtimeVersion: '1.0.0',
        lastSession: 's5',
        lastUserId: USUARIO,
        lastIp: '10.0.0.5',
        summariesCount: 2,
      },
    ]);
    expect(final.vinculos).toEqual([
      {
        userId: USUARIO,
        install: 'i4',
        platform: 'android',
        lastAppVersion: 'V1',
        lastSession: 's5',
        summariesCount: 1,
        lastLoginAt: `${D1}T19:02:00.000Z`,
        lastLogoutAt: `${D1}T19:31:00.000Z`,
      },
    ]);
    expect(final.eventos).toEqual([
      `p10#0 ${D1}T19:31:00.000Z ACTION auth_logout screen=null outcome=null ms=null user=null i4/s5 android V1 recebidoComORecibo=true`,
      `p9#0 ${D1}T19:01:00.000Z SCREEN screen_home screen=null outcome=null ms=3000 user=${USUARIO} i4/s5 android V1 recebidoComORecibo=true`,
      `p9#1 ${D1}T19:02:00.000Z ACTION auth_login_success screen=null outcome=null ms=null user=${USUARIO} i4/s5 android V1 recebidoComORecibo=true`,
      `p9#2 ${D1}T19:03:00.000Z FORM form_login screen=screen_login outcome=success ms=null user=${USUARIO} i4/s5 android V1 recebidoComORecibo=true`,
    ]);
  });

  describe('lote (INSERT ... ON DUPLICATE KEY UPDATE) × caminho antigo (upsert por linha)', () => {
    it('cenário completo: o estado final das tabelas é IDÊNTICO', async () => {
      await aplicarPeloCaminhoAntigo(cenario());
      const peloAntigo = await estado();

      await limpar();
      sequencia = 0;
      await aplicar(cenario());
      const peloNovo = await estado();

      expect(peloNovo).toEqual(peloAntigo);
      // E não é uma igualdade vazia: o antigo também bate com a conta à mão.
      expect(peloAntigo).toMatchObject(ESPERADO);
    });

    it('120 summaries pseudoaleatórios sobre as mesmas chaves: estado final IDÊNTICO', async () => {
      await aplicarPeloCaminhoAntigo(loteAleatorio(120, 20261125));
      const peloAntigo = await estado();

      await limpar();
      sequencia = 0;
      await aplicar(loteAleatorio(120, 20261125));
      const peloNovo = await estado();

      expect(peloNovo).toEqual(peloAntigo);
      expect(peloAntigo.recibos).toHaveLength(120);
      expect(peloAntigo.telas.length).toBeGreaterThan(10);
      expect(peloAntigo.formularios.length).toBeGreaterThan(4);
    });

    it('linhas criadas pelo lote têm `createdAt`/`updatedAt` em UTC, como as do Prisma; na soma seguinte só `updatedAt` anda', async () => {
      const antes = Date.now();
      const [primeiro, segundo] = cenario();

      await aplicar([primeiro]);
      const criada = await prisma.analyticsScreenDaily.findFirstOrThrow({
        where: { ...marcados, screen: 'screen_home' },
      });
      await new Promise((r) => setTimeout(r, 20));
      await aplicar([segundo]);
      const somada = await prisma.analyticsScreenDaily.findFirstOrThrow({
        where: { ...marcados, screen: 'screen_home' },
      });

      // Um desvio de fuso apareceria como horas de diferença.
      expect(Math.abs(criada.createdAt.getTime() - antes)).toBeLessThan(60_000);
      expect(criada.updatedAt.getTime()).toBe(criada.createdAt.getTime());
      expect(somada.id).toBe(criada.id);
      expect(somada.createdAt.getTime()).toBe(criada.createdAt.getTime());
      expect(somada.updatedAt.getTime()).toBeGreaterThan(
        criada.updatedAt.getTime(),
      );
      expect(somada.day.toISOString()).toBe(`${D1}T00:00:00.000Z`);
    });

    it('30 telas, 40 ações e 5 formulários num summary: 4 comandos de agregado no lugar de 75 upserts', async () => {
      // Cliente próprio, só para enxergar os comandos que chegam ao banco.
      const cliente = new PrismaClient({
        datasources: { db: { url: TEST_DATABASE_URL } },
        log: [{ emit: 'event', level: 'query' }],
      });
      const consultas: string[] = [];
      cliente.$on('query', (evento) => consultas.push(evento.query));
      const aplicador = new AnalyticsAplicarResumoService(
        new AnalyticsIngestaoRepository(cliente as unknown as PrismaService),
      );

      const grande = resumo({
        inicio: `${D1}T15:00:00.000Z`,
        install: 'g-i1',
        sessao: 'g-s1',
        telas: Array.from({ length: 30 }, (_, i) => ({
          screen: `screen_${String(i).padStart(2, '0')}`,
          view_count: i + 1,
          total_time_ms: (i + 1) * 100,
        })),
        acoes: Array.from({ length: 40 }, (_, i) => ({
          action: `action_${String(i).padStart(2, '0')}`,
          count: i + 1,
        })),
        formularios: Array.from({ length: 5 }, (_, i) => ({
          screen: 'screen_login',
          form: `form_${i}`,
          started_count: 1,
          submitted_count: 1,
          success_count: 1,
          error_count: 0,
        })),
      });
      try {
        await expect(aplicador.aplicar(grande)).resolves.toBe('APLICADO');
      } finally {
        await cliente.$disconnect();
      }

      const escritasEmAgregado = consultas
        .map(
          (sql) =>
            /^\s*(?:INSERT INTO|UPDATE)\s+(?:`\w+`\.)?`(Analytics\w+Daily)`/.exec(
              sql,
            )?.[1],
        )
        .filter(Boolean);
      expect(escritasEmAgregado).toEqual([
        'AnalyticsSessionDaily',
        'AnalyticsScreenDaily',
        'AnalyticsActionDaily',
        'AnalyticsFormDaily',
      ]);
      // A transação inteira: confere o recibo, grava recibo e únicos, 4 lotes.
      // (O caminho antigo passava de 200 idas ao banco para este summary.)
      expect(consultas.length).toBeLessThan(20);
      const final = await estado();
      expect(final.telas).toHaveLength(30);
      expect(final.acoes).toHaveLength(40);
      expect(final.formularios).toHaveLength(5);
      expect(final.telas[29]).toBe(
        `${D1} android V1 screen_29 views=30 ms=3000`,
      );
    });
  });

  describe('reenvio do mesmo summary', () => {
    it('mesmo payload duas vezes soma UMA vez: o segundo job conclui como descartado', async () => {
      const contador = jest.spyOn(metricas.filaProcessados, 'inc');
      const [primeiro] = cenario();

      await aplicar([primeiro]);
      const depoisDeUm = await estado();
      const [segundaVez] = await aplicar([primeiro]);

      expect(segundaVez).toEqual({ resultado: 'descartado' });
      expect(await estado()).toEqual(depoisDeUm);
      expect(depoisDeUm.recibos).toHaveLength(1);
      expect(depoisDeUm.telas).toEqual([
        `${D1} android V1 screen_home views=2 ms=5000`,
        `${D1} android V1 screen_login views=1 ms=1000`,
      ]);
      expect(contador).toHaveBeenCalledWith({
        queue: ANALYTICS_QUEUE,
        name: 'process-summary',
        resultado: 'descartado',
      });
      contador.mockRestore();
    });

    it('cenário inteiro reenviado (todos os jobs repetidos): nada muda', async () => {
      await aplicar(cenario());
      const depoisDeUm = await estado();

      sequencia = 0;
      const reenvio = await aplicar(cenario());

      expect(reenvio).toEqual(Array(10).fill({ resultado: 'descartado' }));
      expect(await estado()).toEqual(depoisDeUm);
    });

    it('jornada reenviada não duplica eventos nem conta o summary de novo no aparelho', async () => {
      const comJornada = cenario()[8];

      await aplicar([comJornada]);
      await aplicar([comJornada]);

      const final = await estado();
      expect(final.eventos).toHaveLength(3);
      expect(final.aparelhos[0].summariesCount).toBe(1);
      expect(final.vinculos[0].summariesCount).toBe(1);
    });

    it('contraste: pelo caminho antigo o mesmo reenvio somava em dobro', async () => {
      const [primeiro] = cenario();

      await aplicarPeloCaminhoAntigo([primeiro, primeiro]);

      const final = await estado();
      expect(final.recibos).toHaveLength(2);
      expect(final.telas).toContain(
        `${D1} android V1 screen_home views=4 ms=10000`,
      );
    });

    it('recibo duplicado que já exista no banco (dado antigo) também barra o reenvio', async () => {
      const [primeiro] = cenario();
      await aplicarPeloCaminhoAntigo([primeiro, primeiro]);
      const antes = await estado();

      const [resultado] = await aplicar([primeiro]);

      expect(resultado).toEqual({ resultado: 'descartado' });
      expect(await estado()).toEqual(antes);
    });
  });

  describe('concorrência', () => {
    const emParalelo = (lista: Resumo[]) =>
      Promise.allSettled(
        lista.map((dados, i) =>
          processor.process(job(dados, `${MARCA}-par-${i}`)),
        ),
      );

    it('summaries DIFERENTES em paralelo nas mesmas chaves: cada um aplica inteiro ou falha inteiro, e o retry fecha a conta', async () => {
      const lista = Array.from({ length: 12 }, (_, i) =>
        resumo({
          inicio: `${D1}T15:00:00.000Z`,
          install: `c-i${i}`,
          sessao: `c-s${i}`,
          telas: [{ screen: 'screen_home', view_count: 1, total_time_ms: 10 }],
          acoes: [{ action: 'auth_logout', count: 1 }],
        }),
      );

      const primeiraRodada = await emParalelo(lista);
      // Quem colidiu com outra transação (linha de agregado alterada desde a
      // leitura) falhou sem gravar nada; a fila repete o job.
      const falhos = lista.filter(
        (_, i) => primeiraRodada[i].status === 'rejected',
      );
      await aplicar(falhos);

      const final = await estado();
      expect(final.recibos).toHaveLength(12);
      expect(final.telas).toEqual([
        `${D1} android V1 screen_home views=12 ms=120`,
      ]);
      expect(final.acoes).toEqual([`${D1} android V1 auth_logout count=12`]);
      expect(final.sessoesDia).toEqual([
        `${D1} android V1 sessions=12 installs=12`,
      ]);
    });

    it('o MESMO summary em seis execuções simultâneas: UMA aplica (neste banco, pelo isolamento por snapshot do MariaDB)', async () => {
      // Sem índice único em `payloadHash`, quem fecha esta corrida é o banco
      // recusar a escrita em linha alterada depois da leitura (MariaDB ≥
      // 11.6, `innodb_snapshot_isolation=ON`). Em banco sem isso a janela
      // existe e o teste não tem o que afirmar.
      const [variavel] = await prisma.$queryRaw<
        Array<{ ligado: bigint | number }>
      >`SELECT @@innodb_snapshot_isolation AS ligado`.catch(() => [
        { ligado: 0 },
      ]);
      if (Number(variavel?.ligado) !== 1) return;

      const [unico] = cenario();

      const resultados = await emParalelo(Array<Resumo>(6).fill(unico));

      expect(
        resultados.filter(
          (r) =>
            r.status === 'fulfilled' &&
            (r.value as { resultado: string }).resultado === 'aplicado',
        ),
      ).toHaveLength(1);
      const final = await estado();
      expect(final.recibos).toHaveLength(1);
      expect(final.telas).toEqual([
        `${D1} android V1 screen_home views=2 ms=5000`,
        `${D1} android V1 screen_login views=1 ms=1000`,
      ]);
      expect(final.acoes).toEqual([
        `${D1} android V1 auth_login_success count=1`,
      ]);
    });
  });

  describe('transação', () => {
    it('erro no lote de agregados desfaz tudo (recibo incluído): o retry aplica do zero', async () => {
      const [valido] = cenario();
      const invalido: Resumo = {
        ...valido,
        sanitizedPayload: {
          ...valido.sanitizedPayload,
          screens: [
            ...valido.sanitizedPayload.screens,
            // 61 caracteres numa coluna VARCHAR(60).
            { screen: 's'.repeat(61), view_count: 1, total_time_ms: 1 },
          ],
        },
      };

      await expect(
        processor.process(job(invalido, `${MARCA}-erro`)),
      ).rejects.toThrow();

      const depoisDoErro = await estado();
      expect(depoisDoErro.recibos).toEqual([]);
      expect(depoisDoErro.telas).toEqual([]);
      expect(depoisDoErro.sessoesUnicas).toEqual([]);
      expect(depoisDoErro.sessoesDia).toEqual([]);

      // O mesmo `payloadHash`, agora válido, entra normalmente.
      await expect(aplicar([valido])).resolves.toEqual([
        { resultado: 'aplicado' },
      ]);
      expect((await estado()).recibos).toHaveLength(1);
    });
  });

  describe('dashboards sobre o que a ingestão em lote gravou', () => {
    const consulta = { from: D1, to: D2, app_version: V1 };
    let dashboards: AnalyticsDashboardService;

    beforeEach(async () => {
      dashboards = new AnalyticsDashboardService(
        new AnalyticsDashboardRepository(prisma),
      );
      await aplicar(cenario());
    });

    it('telas, ações, formulários e série de sessões', async () => {
      await expect(dashboards.getDashboardScreens(consulta)).resolves.toEqual([
        // 10 (android) + 7 (ios) + 1 (D2)
        {
          screen: 'screen_home',
          viewCount: 18,
          totalTimeMs: 12_580,
          avgTimeMs: 699,
        },
        {
          screen: 'screen_perfil',
          viewCount: 3,
          totalTimeMs: 70,
          avgTimeMs: 23,
        },
        {
          screen: 'screen_login',
          viewCount: 1,
          totalTimeMs: 1000,
          avgTimeMs: 1000,
        },
      ]);
      await expect(dashboards.getDashboardActions(consulta)).resolves.toEqual([
        { action: 'auth_login_success', count: 3 },
        { action: 'auth_logout', count: 1 },
      ]);
      await expect(dashboards.getDashboardForms(consulta)).resolves.toEqual([
        {
          screen: 'screen_login',
          form: 'form_login',
          startedCount: 3,
          submittedCount: 2,
          successCount: 1,
          errorCount: 1,
          successRate: 50,
          errorRate: 50,
        },
      ]);

      const serie = await dashboards.getDashboardSessions(consulta);
      expect(
        serie
          .map(
            (s) =>
              `${s.day} ${s.platform} sessions=${s.sessionsCount} installs=${s.installsCount}`,
          )
          .sort(),
      ).toEqual([
        `${D1} android sessions=4 installs=3`,
        `${D1} ios sessions=1 installs=1`,
        `${D2} android sessions=1 installs=1`,
      ]);
    });

    it('overview e audiência', async () => {
      await expect(
        dashboards.getDashboardOverview(consulta),
      ).resolves.toMatchObject({
        totalSessions: 6,
        totalInstalls: 5,
        totalLoginSuccess: 3,
        totalLogout: 1,
      });

      const audiencia = await dashboards.getDashboardAudience(consulta);
      expect(audiencia.totals).toEqual({
        uniqueDevices: 4, // i1, i2, i4 (android) + i3 (ios)
        uniqueSessions: 5, // s1, s2, s3, s5 + s4
        deviceDays: 5,
        newDevices: 4,
        avgDailyDevices: 2.5,
        wau: 4,
        mau: 4,
        stickiness: 62.5,
      });
      expect(audiencia.days).toBe(2);
      expect(audiencia.platforms).toEqual([
        {
          platform: 'android',
          uniqueDevices: 3,
          uniqueSessions: 4,
          deviceDays: 4,
          newDevices: 3,
          avgDailyDevices: 2,
          sessionsPerDevice: 1.33,
          avgActiveDaysPerDevice: 1.33,
        },
        {
          platform: 'ios',
          uniqueDevices: 1,
          uniqueSessions: 1,
          deviceDays: 1,
          newDevices: 1,
          avgDailyDevices: 0.5,
          sessionsPerDevice: 1,
          avgActiveDaysPerDevice: 1,
        },
      ]);
      expect(
        audiencia.newDevicesDaily
          .map((n) => `${n.day} ${n.platform} ${n.count}`)
          .sort(),
      ).toEqual([`${D1} android 3`, `${D1} ios 1`]);
    });
  });
});

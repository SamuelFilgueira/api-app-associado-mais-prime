import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { AnalyticsModule } from 'src/analytics/analytics.module';
import { AnalyticsIngestProcessor } from 'src/analytics/processors/analytics-ingest.processor';
import { AnalyticsIngestaoRepository } from 'src/analytics/repositories/analytics-ingestao.repository';
import { AnalyticsAplicarResumoService } from 'src/analytics/services/analytics-aplicar-resumo.service';
import { AnalyticsJornadaExpurgoService } from 'src/analytics/services/analytics-jornada-expurgo.service';
import { AnalyticsDashboardService } from 'src/analytics/services/analytics-dashboard.service';
import { AnalyticsJourneyService } from 'src/analytics/services/analytics-journey.service';
import { AnalyticsService } from 'src/analytics/services/analytics.service';
import { PrismaService } from 'src/database/prisma.service';
import { LimitadorService } from 'src/infra/rate-limit/limitador.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import {
  ANALYTICS_QUEUE,
  FILA_DE_MORTOS,
  OPCOES_POR_FILA,
} from 'src/queue/filas';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import {
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  opcoesDoRedisDeTeste,
} from './ambiente';
import { ExpurgoService } from 'src/infra/manutencao/expurgo.service';

const MARCA = `it-af-${process.pid}`;
const VERSAO = MARCA.slice(0, 20);
const DIA = '2001-06-10';

const describeComBancoEFila =
  TEST_DATABASE_URL && TEST_REDIS_URL ? describe : describe.skip;

/** Mesma composição do `QueueModule`: global, com as opções padrão da fila. */
@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: ANALYTICS_QUEUE,
        defaultJobOptions: OPCOES_POR_FILA[ANALYTICS_QUEUE],
      },
      { name: FILA_DE_MORTOS },
    ),
  ],
  providers: [FilaDeMortosService, ProdutorDeFilas],
  exports: [BullModule, FilaDeMortosService, ProdutorDeFilas],
})
class FilasDeTesteModule {}

const esperar = async (condicao: () => Promise<boolean>, prazoMs = 15_000) => {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condição não atingida no prazo');
};

/**
 * Do `POST /analytics/summaries` ao banco, com BullMQ e MariaDB de verdade:
 * o reenvio do mesmo summary é barrado na fila (`jobId` = `payloadHash`) e,
 * quando o primeiro job já saiu do Redis, no banco (recibo).
 */
describeComBancoEFila(
  'Analytics — reenvio do summary, da rota ao banco',
  () => {
    let modulo: TestingModule;
    let prisma: PrismaService;
    let fila: Queue;
    let mortos: Queue;
    let analytics: AnalyticsService;
    const segredoOriginal = process.env.ANALYTICS_SECRET;

    const marcados = { appVersion: VERSAO };
    const limpar = async () => {
      await prisma.analyticsScreenDaily.deleteMany({ where: marcados });
      await prisma.analyticsActionDaily.deleteMany({ where: marcados });
      await prisma.analyticsFormDaily.deleteMany({ where: marcados });
      await prisma.analyticsSessionDaily.deleteMany({ where: marcados });
      await prisma.analyticsDailyUniqueSession.deleteMany({ where: marcados });
      await prisma.analyticsDailyUniqueInstall.deleteMany({ where: marcados });
      await prisma.analyticsInstallFirstSeen.deleteMany({ where: marcados });
      await prisma.analyticsSummaryReceipt.deleteMany({ where: marcados });
    };

    /** Corpo como o app envia. */
    const corpo = (extra: Record<string, unknown> = {}) => ({
      period_start: `${DIA}T15:00:00Z`,
      period_end: `${DIA}T15:30:00Z`,
      app: { platform: 'android', version: VERSAO },
      session: {
        session_id: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789',
        anonymous_install_id: 'b2c3d4e5-f6a7-4890-bcde-f01234567890',
      },
      screens: [{ screen: 'screen_home', view_count: 2, total_time_ms: 5000 }],
      actions: [{ action: 'auth_login_success', count: 1 }],
      forms: [],
      ...extra,
    });

    const telaHome = () =>
      prisma.analyticsScreenDaily.findFirst({
        where: { ...marcados, screen: 'screen_home' },
      });
    const recibos = () =>
      prisma.analyticsSummaryReceipt.count({ where: marcados });

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      process.env.ANALYTICS_SECRET =
        'segredo-de-teste-1234567890abcdef12345678';
      prisma = new PrismaService();
      await prisma.$connect();

      modulo = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({
            connection: opcoesDoRedisDeTeste(),
            prefix: MARCA,
          }),
          FilasDeTesteModule,
        ],
        providers: [
          AnalyticsService,
          AnalyticsAplicarResumoService,
          AnalyticsIngestaoRepository,
          AnalyticsJornadaExpurgoService,
          AnalyticsIngestProcessor,
          { provide: PrismaService, useFactory: () => prisma },
          {
            provide: LimitadorService,
            useValue: { consumir: jest.fn(), avisarRedisFora: jest.fn() },
          },
        ],
      }).compile();
      modulo.useLogger(false);
      await modulo.init();

      fila = modulo.get(getQueueToken(ANALYTICS_QUEUE), { strict: false });
      mortos = modulo.get(getQueueToken(FILA_DE_MORTOS), { strict: false });
      analytics = modulo.get(AnalyticsService);
    });

    afterAll(async () => {
      await fila.obliterate({ force: true });
      await mortos.obliterate({ force: true });
      await modulo.close();
      await limpar();
      await prisma.$disconnect();
      if (segredoOriginal === undefined) delete process.env.ANALYTICS_SECRET;
      else process.env.ANALYTICS_SECRET = segredoOriginal;
    });

    /** Nenhum job esperando ou rodando: o worker terminou o que havia. */
    const filaParada = async () => {
      const { waiting, active, delayed } = await fila.getJobCounts(
        'waiting',
        'active',
        'delayed',
      );
      return waiting + active + delayed === 0;
    };

    beforeEach(async () => {
      // Um job do teste anterior ainda rodando gravaria depois da limpeza.
      await esperar(filaParada);
      for (const job of await fila.getJobs(['completed', 'failed'])) {
        await job.remove();
      }
      await limpar();
    });

    it('o job nasce com o `payloadHash` como id e com o retry e a retenção da fila — sem opções no enfileiramento', async () => {
      await analytics.ingest(corpo(), '127.0.0.1', false);

      const [job] = await fila.getJobs([
        'waiting',
        'active',
        'completed',
        'delayed',
      ]);
      expect(job.id).toMatch(/^[0-9a-f]{64}$/);
      expect(job.id).toBe((job.data as { payloadHash: string }).payloadHash);
      expect(job.opts).toMatchObject({
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 7 * 86_400, count: 5_000 },
      });
    });

    it('o app reenvia o mesmo summary (retry de rede): UM job, agregados somados UMA vez', async () => {
      await analytics.ingest(corpo(), '127.0.0.1', false);
      await analytics.ingest(corpo(), '127.0.0.1', false);
      await analytics.ingest(corpo(), '10.0.0.9', false);

      await esperar(async () => (await recibos()) === 1);
      await esperar(filaParada);

      expect(
        await fila.getJobCounts('waiting', 'active', 'completed', 'failed'),
      ).toMatchObject({ waiting: 0, active: 0, completed: 1, failed: 0 });
      expect(await recibos()).toBe(1);
      expect(await telaHome()).toMatchObject({
        viewCount: 2,
        totalTimeMs: 5000,
      });
    });

    it('reenvio depois de o primeiro job já ter saído do Redis: o segundo job roda, encontra o recibo e é descartado', async () => {
      await analytics.ingest(corpo(), '127.0.0.1', false);
      await esperar(async () => (await recibos()) === 1);
      const [primeiro] = await fila.getJobs(['completed']);
      // A retenção (1 h / 500 jobs) apagaria o job; aqui, na mão.
      await primeiro.remove();

      await analytics.ingest(corpo(), '127.0.0.1', false);
      await esperar(
        async () => (await fila.getJobCounts('completed')).completed === 1,
      );

      const [segundo] = await fila.getJobs(['completed']);
      expect(segundo.id).toBe(primeiro.id);
      expect(segundo.returnvalue).toEqual({ resultado: 'descartado' });
      expect(await recibos()).toBe(1);
      expect(await telaHome()).toMatchObject({
        viewCount: 2,
        totalTimeMs: 5000,
      });
      expect((await mortos.getJobCounts('waiting')).waiting).toBe(0);
    });

    it('summary seguinte da mesma sessão (outro período) é outro job e soma', async () => {
      await analytics.ingest(corpo(), '127.0.0.1', false);
      await analytics.ingest(
        corpo({
          period_start: `${DIA}T15:30:00Z`,
          period_end: `${DIA}T16:00:00Z`,
        }),
        '127.0.0.1',
        false,
      );

      await esperar(async () => (await recibos()) === 2);

      expect(await telaHome()).toMatchObject({
        viewCount: 4,
        totalTimeMs: 10_000,
      });
      const sessoes = await prisma.analyticsSessionDaily.findFirstOrThrow({
        where: marcados,
      });
      // Mesma sessão e mesmo aparelho no dia: contam uma vez.
      expect(sessoes).toMatchObject({ sessionsCount: 1, installsCount: 1 });
    });

    it('job antigo no Redis (enfileirado antes do deploy, id numérico e opções próprias) é processado normalmente', async () => {
      await analytics.ingest(corpo(), '127.0.0.1', false);
      await esperar(async () => (await recibos()) === 1);
      const [novo] = await fila.getJobs(['completed']);
      const dados = novo.data as Record<string, unknown>;
      await novo.remove();
      await limpar();

      // Como o código antigo enfileirava: sem `jobId`, com as opções no job.
      const antigo = await fila.add('process-summary', dados as never, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86400 },
      });
      await esperar(async () => (await antigo.getState()) === 'completed');

      expect(antigo.id).not.toBe(dados.payloadHash);
      expect(await recibos()).toBe(1);
      expect(await telaHome()).toMatchObject({
        viewCount: 2,
        totalTimeMs: 5000,
      });

      // E o reenvio do mesmo summary, já pelo código novo, é descartado.
      await analytics.ingest(corpo(), '127.0.0.1', false);
      await esperar(async () => {
        const job = await fila.getJob(dados.payloadHash as string);
        return (await job?.getState()) === 'completed';
      });
      expect(
        (await fila.getJob(dados.payloadHash as string))?.returnvalue,
      ).toEqual({ resultado: 'descartado' });
      expect(await telaHome()).toMatchObject({
        viewCount: 2,
        totalTimeMs: 5000,
      });
    });
  },
);

/**
 * Por que o `AnalyticsModule` não registra mais a fila: o `ProdutorDeFilas`
 * resolve a fila fora do módulo (`strict: false`), e o Nest devolve o ÚLTIMO
 * provider registrado para o token. Um `registerQueue` num módulo de feature,
 * sem `defaultJobOptions`, passa a ser a fila usada por todo mundo.
 */
(TEST_REDIS_URL ? describe : describe.skip)(
  'Fila registrada duas vezes — a armadilha das opções padrão',
  () => {
    const montar = async (registrarDeNovo: boolean) => {
      @Module({
        imports: registrarDeNovo
          ? [BullModule.registerQueue({ name: ANALYTICS_QUEUE })]
          : [],
      })
      class ModuloDeFeature {}

      const modulo = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({
            connection: opcoesDoRedisDeTeste(),
            prefix: `${MARCA}-dup-${registrarDeNovo ? 's' : 'n'}`,
          }),
          FilasDeTesteModule,
          ModuloDeFeature,
        ],
      }).compile();
      await modulo.init();
      return modulo;
    };

    const opcoesDoJob = async (modulo: TestingModule) => {
      const produtor = modulo.get(ProdutorDeFilas, { strict: false });
      const job = await produtor.enfileirar(
        ANALYTICS_QUEUE,
        'process-summary',
        { x: 1 },
        { atrasoMs: 60_000 },
      );
      const opcoes = job.opts;
      // Apaga do Redis tudo o que este módulo criou (as duas filas).
      for (const nome of [ANALYTICS_QUEUE, FILA_DE_MORTOS]) {
        const fila = modulo.get<Queue>(getQueueToken(nome), { strict: false });
        await fila.obliterate({ force: true });
      }
      await modulo.close();
      return opcoes;
    };

    it('só o registro global: o job leva o retry e a retenção da fila', async () => {
      const opcoes = await opcoesDoJob(await montar(false));

      expect(opcoes.attempts).toBe(5);
      expect(opcoes.removeOnComplete).toEqual({ age: 3600, count: 500 });
    });

    it('com um segundo registro num módulo de feature: o job nasce SEM retry e SEM retenção', async () => {
      const opcoes = await opcoesDoJob(await montar(true));

      expect(opcoes.attempts ?? 0).toBeLessThanOrEqual(1);
      expect(opcoes.removeOnComplete).toBeUndefined();
      expect(opcoes.removeOnFail).toBeUndefined();
    });

    it('o AnalyticsModule de verdade sobe só com a fila do módulo global, e é essa a fila que os seus serviços recebem', async () => {
      @Global()
      @Module({
        providers: [
          { provide: PrismaService, useValue: {} },
          { provide: LimitadorService, useValue: {} },
          // A limpeza da jornada se registra na manutenção (módulo global).
          { provide: ExpurgoService, useValue: { registrarRotina: jest.fn() } },
        ],
        exports: [PrismaService, LimitadorService, ExpurgoService],
      })
      class InfraDeTesteModule {}

      const modulo = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({
            connection: opcoesDoRedisDeTeste(),
            prefix: `${MARCA}-boot`,
          }),
          FilasDeTesteModule,
          InfraDeTesteModule,
          AnalyticsModule,
        ],
      }).compile();
      modulo.useLogger(false);
      await modulo.init();

      try {
        const filaGlobal = modulo.get<Queue>(getQueueToken(ANALYTICS_QUEUE), {
          strict: false,
        });
        const daJornada = (
          modulo.get(AnalyticsJourneyService) as unknown as {
            analyticsQueue: Queue;
          }
        ).analyticsQueue;

        expect(daJornada).toBe(filaGlobal);
        expect(filaGlobal.defaultJobOptions).toMatchObject({ attempts: 5 });
        expect(modulo.get(AnalyticsService)).toBeInstanceOf(AnalyticsService);
        expect(modulo.get(AnalyticsDashboardService)).toBeInstanceOf(
          AnalyticsDashboardService,
        );
        expect(modulo.get(AnalyticsIngestProcessor)).toBeInstanceOf(
          AnalyticsIngestProcessor,
        );
        // Exportado: a rotina de manutenção o alcança de fora do módulo.
        expect(
          modulo.get(AnalyticsJornadaExpurgoService, { strict: false }),
        ).toBeInstanceOf(AnalyticsJornadaExpurgoService);
      } finally {
        for (const nome of [ANALYTICS_QUEUE, FILA_DE_MORTOS]) {
          const fila = modulo.get<Queue>(getQueueToken(nome), {
            strict: false,
          });
          await fila.obliterate({ force: true });
        }
        await modulo.close();
      }
    });
  },
);

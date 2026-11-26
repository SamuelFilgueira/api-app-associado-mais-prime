import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import { EconomiaService } from 'src/economia/services/economia.service';
import { FuelEconomyProcessor } from 'src/fuel-session/processors/fuel-economy.processor';
import { FuelSessionRepository } from 'src/fuel-session/repositories/fuel-session.repository';
import { FuelSessionService } from 'src/fuel-session/services/fuel-session.service';
import {
  ResultadoDaVerificacao,
  VerificacaoDeEconomiaService,
} from 'src/fuel-session/services/verificacao-de-economia.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import {
  FILA_DE_MORTOS,
  FUEL_ECONOMY_QUEUE,
  OPCOES_POR_FILA,
} from 'src/queue/filas';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import {
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  describeComBanco,
  opcoesDoRedisDeTeste,
} from './ambiente';

const MARCA = `it-fuel-${process.pid}`;
const MINUTO = 60_000;

/**
 * Sessão de verificação de economia contra o banco real: o índice único de
 * `pendenteChave` (uma sessão pendente por usuário) e as saídas de `PENDING`
 * condicionais (`UPDATE ... WHERE status = 'PENDING'`).
 */
describeComBanco('Banco real — sessão de economia de combustível', () => {
  let prisma: PrismaService;
  let sessoes: FuelSessionRepository;
  let userId: number;

  /** Total que o "Clubgas" devolve; não toca no banco. */
  const economia = { consultarTotalEconomizado: jest.fn() };
  const notifications = { sendPushNotification: jest.fn() };
  const produtor = { enfileirar: jest.fn() };

  const totalDoUsuario = async () =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
      .totalEconomizado;
  const sessoesDoUsuario = (status?: string) =>
    prisma.fuelSession.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    sessoes = new FuelSessionRepository(prisma);

    const usuario = await prisma.user.create({
      data: {
        name: MARCA,
        cpf: `8${String(process.pid).padStart(10, '0')}`.slice(0, 11),
        email: `${MARCA}@teste.local`,
        passwordHash: 'x',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: 'ExponentPushToken[it-fuel]',
      },
    });
    userId = usuario.id;
  });

  afterAll(async () => {
    // As sessões saem em cascata com o usuário.
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    economia.consultarTotalEconomizado.mockResolvedValue({
      totalEconomizado: '100',
    });
    notifications.sendPushNotification.mockResolvedValue({ success: true });
    produtor.enfileirar.mockResolvedValue({ id: 'job' });
    await prisma.fuelSession.deleteMany({ where: { userId } });
    await prisma.user.update({
      where: { id: userId },
      data: { totalEconomizado: 0 },
    });
  });

  const novaVerificacao = () =>
    new VerificacaoDeEconomiaService(
      sessoes,
      economia as unknown as EconomiaService,
      notifications as unknown as NotificationsService,
      prisma,
      produtor as unknown as ProdutorDeFilas,
    );
  const novaAbertura = () =>
    new FuelSessionService(
      sessoes,
      economia as unknown as EconomiaService,
      produtor as unknown as ProdutorDeFilas,
    );

  describe('uma sessão pendente por usuário', () => {
    it('dez toques simultâneos criam UMA sessão PENDING; os outros recebem a mesma', async () => {
      const resultados = await Promise.all(
        Array.from({ length: 10 }, () => sessoes.criarPendente(userId, 100)),
      );

      expect(resultados.filter((r) => r.criada)).toHaveLength(1);
      expect(new Set(resultados.map((r) => r.sessao.id)).size).toBe(1);
      const pendentes = await sessoesDoUsuario('PENDING');
      expect(pendentes).toHaveLength(1);
      expect(pendentes[0].pendenteChave).toBe(String(userId));
    });

    it('o banco recusa a segunda sessão pendente do mesmo usuário (P2002)', async () => {
      await sessoes.criarPendente(userId, 100);

      await expect(
        prisma.fuelSession.create({
          data: {
            userId,
            valorAntes: 100,
            status: 'PENDING',
            pendenteChave: String(userId),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('pelo caso de uso: dois toques → uma sessão, UM job e o valor de partida lido do Clubgas', async () => {
      economia.consultarTotalEconomizado.mockResolvedValue({
        totalEconomizado: '87.5',
      });
      // O cadastro local está defasado de propósito: não é ele que vale.
      await prisma.user.update({
        where: { id: userId },
        data: { totalEconomizado: 10 },
      });
      const abertura = novaAbertura();

      const resultados = await Promise.all([
        abertura.abrirSessao(userId, 'MAIS_PRIME'),
        abertura.abrirSessao(userId, 'MAIS_PRIME'),
        abertura.abrirSessao(userId, 'MAIS_PRIME'),
      ]);

      expect(resultados.map((r) => r.situacao).sort()).toEqual([
        'ABERTA',
        'JA_PENDENTE',
        'JA_PENDENTE',
      ]);
      expect(new Set(resultados.map((r) => r.sessao?.id)).size).toBe(1);
      const [sessao, ...resto] = await sessoesDoUsuario();
      expect(resto).toHaveLength(0);
      expect(sessao).toMatchObject({ status: 'PENDING', valorAntes: 87.5 });
      expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
      expect(produtor.enfileirar).toHaveBeenCalledWith(
        FUEL_ECONOMY_QUEUE,
        'check-fuel-economy',
        { fuelSessionId: sessao.id, checagem: 1 },
        {
          base: 'MAIS_PRIME',
          atrasoMs: 5 * MINUTO,
          jobId: `fuel-${sessao.id}-c1`,
        },
      );
    });

    it('a chave é anulada ao sair de PENDING: depois de concluir ou expirar, cabe uma sessão nova', async () => {
      const { sessao: primeira } = await sessoes.criarPendente(userId, 100);
      expect(await sessoes.expirar(primeira.id)).toBe(true);

      const { sessao: segunda, criada } = await sessoes.criarPendente(
        userId,
        100,
      );
      expect(criada).toBe(true);
      expect(
        await sessoes.concluir({
          sessionId: segunda.id,
          userId,
          valorDepois: 120,
          diferenca: 20,
        }),
      ).toBe(true);

      const terceira = await sessoes.criarPendente(userId, 120);
      expect(terceira.criada).toBe(true);
      expect(
        (await sessoesDoUsuario()).map((s) => [s.status, s.pendenteChave]),
      ).toEqual([
        ['EXPIRED', null],
        ['COMPLETED', null],
        ['PENDING', String(userId)],
      ]);
    });

    it('sessão PENDING antiga, criada antes da coluna (chave nula): o segundo toque ainda a encontra', async () => {
      const legada = await prisma.fuelSession.create({
        data: { userId, valorAntes: 50, status: 'PENDING' },
      });

      await expect(
        novaAbertura().abrirSessao(userId, 'MAIS_PRIME'),
      ).resolves.toMatchObject({
        situacao: 'JA_PENDENTE',
        sessao: { id: legada.id },
      });
      expect(await sessoesDoUsuario()).toHaveLength(1);
      expect(produtor.enfileirar).not.toHaveBeenCalled();
    });

    it('chave presa em sessão já encerrada (worker antigo durante o deploy não a anula): a abertura seguinte solta a chave e cria a sessão', async () => {
      const { sessao: antiga } = await sessoes.criarPendente(userId, 100);
      // Como o worker anterior a esta coluna encerrava: só o status.
      await prisma.fuelSession.update({
        where: { id: antiga.id },
        data: { status: 'EXPIRED' },
      });

      const abertura = await novaAbertura().abrirSessao(userId, 'MAIS_PRIME');

      expect(abertura.situacao).toBe('ABERTA');
      expect(abertura.sessao?.id).not.toBe(antiga.id);
      expect(
        (await sessoesDoUsuario()).map((s) => [s.status, s.pendenteChave]),
      ).toEqual([
        ['EXPIRED', null],
        ['PENDING', String(userId)],
      ]);
      expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
    });

    it('sessão PENDING órfã (mais de 30 min) vence na abertura seguinte e não bloqueia o usuário', async () => {
      const orfa = await prisma.fuelSession.create({
        data: {
          userId,
          valorAntes: 50,
          status: 'PENDING',
          pendenteChave: String(userId),
          createdAt: new Date(Date.now() - 31 * MINUTO),
        },
      });

      const abertura = await novaAbertura().abrirSessao(userId, 'MAIS_PRIME');

      expect(abertura.situacao).toBe('ABERTA');
      expect(abertura.sessao?.id).not.toBe(orfa.id);
      expect(
        await prisma.fuelSession.findUniqueOrThrow({ where: { id: orfa.id } }),
      ).toMatchObject({ status: 'EXPIRED', pendenteChave: null });
    });

    it('sessão PENDING recente (menos de 30 min) não vence por tempo', async () => {
      const { sessao } = await sessoes.criarPendente(userId, 100);
      await prisma.fuelSession.update({
        where: { id: sessao.id },
        data: { createdAt: new Date(Date.now() - 29 * MINUTO) },
      });

      await expect(
        novaAbertura().abrirSessao(userId, 'MAIS_PRIME'),
      ).resolves.toMatchObject({
        situacao: 'JA_PENDENTE',
        sessao: { id: sessao.id },
      });
    });
  });

  describe('saída de PENDING: só quem ganha repete efeito', () => {
    it('conclusão: grava a sessão e o total do usuário na mesma transação', async () => {
      const { sessao } = await sessoes.criarPendente(userId, 100);

      await expect(
        sessoes.concluir({
          sessionId: sessao.id,
          userId,
          valorDepois: 112.5,
          diferenca: 12.5,
        }),
      ).resolves.toBe(true);

      expect(
        await prisma.fuelSession.findUniqueOrThrow({
          where: { id: sessao.id },
        }),
      ).toMatchObject({
        status: 'COMPLETED',
        valorAntes: 100,
        valorDepois: 112.5,
        diferenca: 12.5,
        pendenteChave: null,
      });
      expect(await totalDoUsuario()).toBe(112.5);
    });

    it('dez conclusões simultâneas com valores diferentes: UMA vence e é a única gravada', async () => {
      const { sessao } = await sessoes.criarPendente(userId, 100);

      const resultados = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          sessoes.concluir({
            sessionId: sessao.id,
            userId,
            valorDepois: 200 + i,
            diferenca: 100 + i,
          }),
        ),
      );

      expect(resultados.filter(Boolean)).toHaveLength(1);
      const vencedora = 200 + resultados.indexOf(true);
      const final = await prisma.fuelSession.findUniqueOrThrow({
        where: { id: sessao.id },
      });
      expect(final).toMatchObject({
        status: 'COMPLETED',
        valorDepois: vencedora,
        diferenca: vencedora - 100,
      });
      // O total do usuário é o da conclusão que venceu — as outras nove não
      // gravaram por cima.
      expect(await totalDoUsuario()).toBe(vencedora);
    });

    it('duas execuções simultâneas do job de conclusão: UM push e UMA atualização do total', async () => {
      const { sessao } = await sessoes.criarPendente(userId, 100);
      economia.consultarTotalEconomizado.mockResolvedValue({
        totalEconomizado: '112.5',
      });
      const verificacao = novaVerificacao();

      const resultados = await Promise.all(
        Array.from({ length: 6 }, () =>
          verificacao.verificar({ fuelSessionId: sessao.id, checagem: 1 }, 0),
        ),
      );

      const concluidas = resultados.filter(
        (r): r is Extract<ResultadoDaVerificacao, { processed: true }> =>
          'processed' in r && r.processed,
      );
      expect(concluidas).toEqual([
        { processed: true, diferenca: 12.5, novoTotal: 112.5, push: 'enviado' },
      ]);
      expect(
        resultados.filter((r) => 'skipped' in r && r.skipped),
      ).toHaveLength(5);
      expect(notifications.sendPushNotification).toHaveBeenCalledTimes(1);
      expect(await totalDoUsuario()).toBe(112.5);
      expect(await sessoesDoUsuario('COMPLETED')).toHaveLength(1);
    });

    it('expirar e concluir ao mesmo tempo: uma das duas vence, nunca as duas', async () => {
      for (let rodada = 0; rodada < 5; rodada++) {
        await prisma.fuelSession.deleteMany({ where: { userId } });
        await prisma.user.update({
          where: { id: userId },
          data: { totalEconomizado: 0 },
        });
        const { sessao } = await sessoes.criarPendente(userId, 100);

        const [expirou, concluiu] = await Promise.all([
          sessoes.expirar(sessao.id),
          sessoes.concluir({
            sessionId: sessao.id,
            userId,
            valorDepois: 150,
            diferenca: 50,
          }),
        ]);

        expect([expirou, concluiu].filter(Boolean)).toHaveLength(1);
        const final = await prisma.fuelSession.findUniqueOrThrow({
          where: { id: sessao.id },
        });
        expect(final.status).toBe(concluiu ? 'COMPLETED' : 'EXPIRED');
        // Sessão expirada não soma no total do usuário.
        expect(await totalDoUsuario()).toBe(concluiu ? 150 : 0);
      }
    });

    it('expirar sessão já concluída não muda nada', async () => {
      const { sessao } = await sessoes.criarPendente(userId, 100);
      await sessoes.concluir({
        sessionId: sessao.id,
        userId,
        valorDepois: 150,
        diferenca: 50,
      });

      await expect(sessoes.expirar(sessao.id)).resolves.toBe(false);
      expect(
        (
          await prisma.fuelSession.findUniqueOrThrow({
            where: { id: sessao.id },
          })
        ).status,
      ).toBe('COMPLETED');
    });
  });

  describe('checagens sem variação', () => {
    it('job antigo, sem contador no payload: funciona e segue a mesma linha do tempo', async () => {
      const { sessao } = await sessoes.criarPendente(userId, 100);
      const verificacao = novaVerificacao();

      // Primeira execução do job antigo: reagenda como checagem 2.
      await expect(
        verificacao.verificar({ fuelSessionId: sessao.id }, 0),
      ).resolves.toMatchObject({ reason: 'sem_variacao', proximaChecagem: 2 });
      expect(await sessoesDoUsuario('PENDING')).toHaveLength(1);

      // Job antigo que já tinha gasto as duas primeiras tentativas: expira.
      await expect(
        verificacao.verificar({ fuelSessionId: sessao.id }, 2),
      ).resolves.toMatchObject({ reason: 'teto_de_checagens', expirada: true });
      expect(
        await prisma.fuelSession.findUniqueOrThrow({
          where: { id: sessao.id },
        }),
      ).toMatchObject({ status: 'EXPIRED', pendenteChave: null });
      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });
  });

  // ── Fila de verdade: o job conclui, reagenda e nada vai para os mortos ──
  const describeComFila = TEST_REDIS_URL ? describe : describe.skip;

  describeComFila('com BullMQ real', () => {
    let modulo: TestingModule;
    let fila: Queue;
    let mortos: Queue;

    const esperar = async (
      condicao: () => Promise<boolean>,
      prazoMs = 15_000,
    ) => {
      const fim = Date.now() + prazoMs;
      while (Date.now() < fim) {
        if (await condicao()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('condição não atingida no prazo');
    };

    beforeAll(async () => {
      modulo = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({
            connection: opcoesDoRedisDeTeste(),
            prefix: MARCA,
          }),
          BullModule.registerQueue(
            {
              name: FUEL_ECONOMY_QUEUE,
              // As opções de produção: é com elas que o job não pode falhar.
              defaultJobOptions: OPCOES_POR_FILA[FUEL_ECONOMY_QUEUE],
            },
            { name: FILA_DE_MORTOS },
          ),
        ],
        providers: [
          FilaDeMortosService,
          ProdutorDeFilas,
          FuelEconomyProcessor,
          VerificacaoDeEconomiaService,
          FuelSessionService,
          { provide: FuelSessionRepository, useFactory: () => sessoes },
          { provide: PrismaService, useFactory: () => prisma },
          { provide: EconomiaService, useValue: economia },
          { provide: NotificationsService, useValue: notifications },
        ],
      }).compile();
      modulo.useLogger(false);
      await modulo.init();
      fila = modulo.get(getQueueToken(FUEL_ECONOMY_QUEUE));
      mortos = modulo.get(getQueueToken(FILA_DE_MORTOS));
    });

    afterAll(async () => {
      await fila.obliterate({ force: true });
      await mortos.obliterate({ force: true });
      await modulo.close();
    });

    it('cartão consultado sem abastecimento: 3 checagens concluídas, sessão expirada, NENHUM job falho ou morto', async () => {
      const abertura = await modulo
        .get(FuelSessionService)
        .abrirSessao(userId, 'MAIS_PRIME');
      const sessionId = abertura.sessao!.id;
      const idDoJob = (n: number) => `fuel-${sessionId}-c${n}`;

      // Checagem 1: agendada para 5 minutos depois do toque.
      const primeira = await fila.getJob(idDoJob(1));
      expect(primeira?.opts.delay).toBe(5 * MINUTO);
      expect(primeira?.data).toMatchObject({
        fuelSessionId: sessionId,
        checagem: 1,
        baseOrigin: 'MAIS_PRIME',
      });
      // Retry só para erro de verdade: o padrão da fila, sem opções no job.
      expect(primeira?.opts.attempts).toBe(3);
      expect(primeira?.opts.backoff).toEqual({
        type: 'exponential',
        delay: 60_000,
      });

      const atrasos: number[] = [];
      for (const checagem of [1, 2, 3]) {
        const job = await fila.getJob(idDoJob(checagem));
        expect(job).toBeDefined();
        atrasos.push(job!.opts.delay ?? 0);
        await job!.promote();
        await esperar(async () => (await job!.getState()) === 'completed');
      }

      // Mesmos tempos de antes: 5 min, depois 60 s e 120 s.
      expect(atrasos).toEqual([5 * MINUTO, MINUTO, 2 * MINUTO]);
      expect(await fila.getJob(idDoJob(4))).toBeUndefined();
      expect(
        await fila.getJobCounts('failed', 'delayed', 'waiting'),
      ).toMatchObject({ failed: 0, delayed: 0, waiting: 0 });
      expect(await mortos.getJobCounts('waiting', 'delayed')).toMatchObject({
        waiting: 0,
        delayed: 0,
      });
      expect(
        (await fila.getJob(idDoJob(3)))?.returnvalue as ResultadoDaVerificacao,
      ).toEqual({
        processed: false,
        reason: 'teto_de_checagens',
        checagem: 3,
        expirada: true,
      });
      expect(
        await prisma.fuelSession.findUniqueOrThrow({
          where: { id: sessionId },
        }),
      ).toMatchObject({ status: 'EXPIRED', pendenteChave: null });
      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });

    it('abastecimento percebido na segunda checagem: conclui, um push e a cadeia para ali', async () => {
      const abertura = await modulo
        .get(FuelSessionService)
        .abrirSessao(userId, 'MAIS_PRIME');
      const sessionId = abertura.sessao!.id;

      const primeira = await fila.getJob(`fuel-${sessionId}-c1`);
      await primeira!.promote();
      await esperar(async () => (await primeira!.getState()) === 'completed');

      economia.consultarTotalEconomizado.mockResolvedValue({
        totalEconomizado: '130',
      });
      const segunda = await fila.getJob(`fuel-${sessionId}-c2`);
      await segunda!.promote();
      await esperar(async () => (await segunda!.getState()) === 'completed');

      expect((await fila.getJob(segunda!.id!))?.returnvalue).toEqual({
        processed: true,
        diferenca: 30,
        novoTotal: 130,
        push: 'enviado',
      });
      expect(await fila.getJob(`fuel-${sessionId}-c3`)).toBeUndefined();
      expect(notifications.sendPushNotification).toHaveBeenCalledTimes(1);
      expect(
        await prisma.fuelSession.findUniqueOrThrow({
          where: { id: sessionId },
        }),
      ).toMatchObject({ status: 'COMPLETED', valorDepois: 130, diferenca: 30 });
      expect(await totalDoUsuario()).toBe(130);
    });

    it('job antigo no Redis (sem contador, com o retry gravado nele): conclui e reagenda', async () => {
      const { sessao } = await sessoes.criarPendente(userId, 100);
      // Exatamente como o `cartao.service` antigo enfileirava.
      const antigo = await fila.add(
        'check-fuel-economy',
        { fuelSessionId: sessao.id },
        { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
      );

      await esperar(async () => (await antigo.getState()) === 'completed');

      const proxima = await fila.getJob(`fuel-${sessao.id}-c2`);
      expect(proxima?.data).toMatchObject({
        fuelSessionId: sessao.id,
        checagem: 2,
      });
      expect(proxima?.opts.delay).toBe(MINUTO);
      expect((await mortos.getJobCounts('waiting')).waiting).toBe(0);
      await proxima!.remove();
    });

    it('erro de verdade esgotando as tentativas: aí sim o job morre, e a sessão é expirada', async () => {
      const { sessao } = await sessoes.criarPendente(userId, 100);
      economia.consultarTotalEconomizado.mockRejectedValue(
        new Error('ECONNRESET: Clubgas fora'),
      );
      const job = await fila.add(
        'check-fuel-economy',
        { fuelSessionId: sessao.id, checagem: 1 },
        // Backoff curto só para o teste não esperar minutos.
        { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
      );

      await esperar(
        async () => (await mortos.getJobCounts('waiting')).waiting === 1,
      );
      await esperar(async () => {
        const atual = await prisma.fuelSession.findUniqueOrThrow({
          where: { id: sessao.id },
        });
        return atual.status === 'EXPIRED';
      });

      expect(await job.getState()).toBe('failed');
      expect(economia.consultarTotalEconomizado).toHaveBeenCalledTimes(2);
      expect(
        await prisma.fuelSession.findUniqueOrThrow({
          where: { id: sessao.id },
        }),
      ).toMatchObject({ status: 'EXPIRED', pendenteChave: null });
    });
  });
});

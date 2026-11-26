import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import * as ExcelJS from 'exceljs';
import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';
import { TravaService } from 'src/infra/redis/trava.service';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import {
  ResultadoDoLote,
  jobIdDosRecibos,
} from 'src/notifications/domain/push-disparo';
import { PushMassaProcessor } from 'src/notifications/processors/push-massa.processor';
import {
  DisparoPush,
  PushDisparoRepository,
} from 'src/notifications/repositories/push-disparo.repository';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { PushAvulsosService } from 'src/notifications/services/push-avulsos.service';
import { PushDisparoService } from 'src/notifications/services/push-disparo.service';
import {
  LoteEmExecucaoError,
  PushLoteService,
} from 'src/notifications/services/push-lote.service';
import { PushRecibosService } from 'src/notifications/services/push-recibos.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';
import { SituacaoCadastroNotificationService } from 'src/notifications/services/situacao-cadastro-notification.service';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import {
  FILA_DE_MORTOS,
  OPCOES_POR_FILA,
  PUSH_MASSA_QUEUE,
} from 'src/queue/filas';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import {
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  opcoesDoRedisDeTeste,
  redisDeTeste,
} from './ambiente';

const describeComBancoERedis =
  TEST_DATABASE_URL && TEST_REDIS_URL ? describe : describe.skip;

const MARCA = `it-push-${process.pid}`;
/** Faixa de CPFs só desta execução (dígitos verificadores calculados). */
const BASE_DO_CPF = 610_000_000 + (process.pid % 9_000) * 1_000;

function cpfValido(sequencial: number): string {
  const base = String(BASE_DO_CPF + sequencial);
  const digito = (parcial: string) => {
    let soma = 0;
    for (let i = 0; i < parcial.length; i++) {
      soma += Number(parcial[i]) * (parcial.length + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(base);
  return `${base}${d1}${digito(`${base}${d1}`)}`;
}

const tokenDe = (userId: number) => `ExponentPushToken[${MARCA}-${userId}]`;

const esperar = async (condicao: () => Promise<boolean>, prazoMs = 25_000) => {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no prazo');
};

/**
 * Push em massa de ponta a ponta: MariaDB e Redis/BullMQ reais; só o Expo é
 * falso (`PushGateway`). É aqui que valem o `UPDATE ... WHERE estado IN`, a
 * transação do resultado do lote, a trava no Redis e o retry do BullMQ.
 */
describeComBancoERedis('Push em massa — disparo → lotes → entregas', () => {
  let modulo: TestingModule;
  let prisma: PrismaService;
  let redis: Redis;
  let gateway: PushGatewayFalso;
  let fila: Queue;
  let mortos: Queue;
  let repo: PushDisparoRepository;
  let disparos: PushDisparoService;
  let lotes: PushLoteService;
  let recibos: PushRecibosService;
  let audit: MarketingNotificationAuditService;
  let planilha: SituacaoCadastroNotificationService;

  let adminId: number;
  /** 250 usuários de teste, em ordem de id. */
  let usuarios: Array<{ id: number; cpf: string }>;
  const disparosCriados: number[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    redis = redisDeTeste();
    gateway = new PushGatewayFalso();

    modulo = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: opcoesDoRedisDeTeste(),
          prefix: `${MARCA}-filas`,
        }),
        BullModule.registerQueue(
          {
            name: PUSH_MASSA_QUEUE,
            // As 5 tentativas da fila de verdade, com a espera encurtada.
            defaultJobOptions: {
              ...OPCOES_POR_FILA[PUSH_MASSA_QUEUE],
              backoff: { type: 'fixed', delay: 150 },
            },
          },
          { name: FILA_DE_MORTOS },
        ),
      ],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: PushGateway, useValue: gateway },
        { provide: REDIS_CLIENTE, useValue: redis },
        TravaService,
        IdempotenciaService,
        FilaDeMortosService,
        ProdutorDeFilas,
        PushDisparoRepository,
        PushRecibosService,
        PushLoteService,
        PushDisparoService,
        PushAvulsosService,
        CaixaDeEntradaService,
        PushTokenService,
        MarketingNotificationAuditService,
        SituacaoCadastroNotificationService,
        PushMassaProcessor,
      ],
    }).compile();
    modulo.useLogger(false);
    await modulo.init();

    fila = modulo.get(getQueueToken(PUSH_MASSA_QUEUE));
    mortos = modulo.get(getQueueToken(FILA_DE_MORTOS));
    repo = modulo.get(PushDisparoRepository);
    disparos = modulo.get(PushDisparoService);
    lotes = modulo.get(PushLoteService);
    recibos = modulo.get(PushRecibosService);
    audit = modulo.get(MarketingNotificationAuditService);
    planilha = modulo.get(SituacaoCadastroNotificationService);

    const admin = await prisma.adminPanelUser.create({
      data: {
        name: MARCA,
        email: `${MARCA}@teste.local`,
        password: 'x',
        role: 'MARKETING',
      },
    });
    adminId = admin.id;

    await prisma.user.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        name: `${MARCA}-${i}`,
        cpf: cpfValido(i),
        email: `${MARCA}-${i}@teste.local`,
        passwordHash: 'x',
        baseOrigin: 'MAIS_PRIME',
      })),
    });
    usuarios = await prisma.user.findMany({
      where: { email: { startsWith: `${MARCA}-` } },
      select: { id: true, cpf: true },
      orderBy: { id: 'asc' },
    });
  });

  afterAll(async () => {
    await fila.obliterate({ force: true });
    await mortos.obliterate({ force: true });
    await modulo.close();

    // Só o que este arquivo criou (entregas e caixa de entrada caem em cascata).
    await prisma.pushDisparo.deleteMany({
      where: { id: { in: disparosCriados } },
    });
    await prisma.pushDisparo.deleteMany({
      where: { titulo: { startsWith: MARCA } },
    });
    await prisma.marketingNotificationAuditLog.deleteMany({
      where: { adminPanelUserId: adminId },
    });
    await prisma.chaveDeIdempotencia.deleteMany({ where: { userId: adminId } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: `${MARCA}-` } },
    });
    await prisma.adminPanelUser.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(async () => {
    gateway.limpar();
    // Cada caso começa com os tokens originais (só os usuários deste arquivo).
    const prefixo = `ExponentPushToken[${MARCA}-`;
    const email = `${MARCA}-%`;
    await prisma.$executeRaw`UPDATE \`user\` SET expoPushToken = CONCAT(${prefixo}, id, ']') WHERE email LIKE ${email}`;
    await prisma.notification.deleteMany({
      where: { userId: { in: usuarios.map((u) => u.id) } },
    });
  });

  const destinatarios = (total: number) =>
    usuarios.slice(0, total).map((u) => ({
      userId: u.id,
      expoPushToken: tokenDe(u.id),
    }));

  /** Cria o disparo pela porta de sempre (log do painel + lotes na fila). */
  async function disparar(titulo: string, total: number) {
    const auditId = await audit.createRequestAudit(adminId, {
      title: `${MARCA} ${titulo}`,
      body: 'Corpo',
    });
    const criado = await disparos.criar(
      {
        tipo: 'MARKETING',
        titulo: `${MARCA} ${titulo}`,
        corpo: 'Corpo',
        dados: { type: 'marketing' },
        marketingAuditLogId: auditId,
      },
      disparos.fonteFixa(destinatarios(total), 0),
    );
    disparosCriados.push(criado.disparoId);
    return { ...criado, auditId: auditId as number };
  }

  /** Disparo já em `ENVIANDO`, SEM job na fila: o teste roda o lote na mão. */
  async function disparoSemFila(total: number): Promise<DisparoPush> {
    const disparo = await repo.criarDisparo({
      tipo: 'MARKETING',
      titulo: `${MARCA} sem fila`,
      corpo: 'Corpo',
      dados: { type: 'marketing' },
    });
    disparosCriados.push(disparo.id);
    await repo.criarEntregas(disparo.id, destinatarios(total));
    await repo.iniciarEnvio(disparo.id, { total, ignorados: 0 }, new Date());
    return (await repo.buscarDisparo(disparo.id)) as DisparoPush;
  }

  const paginaInteira = async (disparoId: number) => {
    const entregas = await prisma.pushEntrega.findMany({
      where: { disparoId },
      orderBy: { id: 'asc' },
    });
    return {
      disparoId,
      deId: entregas[0].id,
      ateId: entregas[entregas.length - 1].id,
    };
  };

  const concluido = (disparoId: number) => async () =>
    ['CONCLUIDO', 'FALHOU'].includes(
      (await repo.buscarDisparo(disparoId))?.estado ?? '',
    );

  const historicoPorUsuario = async () => {
    const linhas = await prisma.notification.groupBy({
      by: ['userId'],
      where: { userId: { in: usuarios.map((u) => u.id) } },
      _count: { _all: true },
    });
    return new Map(linhas.map((l) => [l.userId, l._count._all]));
  };

  const aceitosDosMeusTokens = () =>
    [...gateway.aceitosPorToken()].filter(([token]) => token.includes(MARCA));

  it('250 destinatários: a criação não envia; os lotes entregam UM push e UMA linha de histórico a cada um e o log fecha com a contagem real', async () => {
    const criado = await disparar('250', 250);

    expect(criado).toMatchObject({
      estado: 'ENVIANDO',
      totalDestinatarios: 250,
      repetido: false,
    });
    await esperar(concluido(criado.disparoId));

    // Um push aceito por destinatário.
    const aceitos = new Map(aceitosDosMeusTokens());
    for (const usuario of usuarios) {
      expect(aceitos.get(tokenDe(usuario.id))).toBe(1);
    }
    // Uma linha de histórico por destinatário, com o token dele.
    const historico = await historicoPorUsuario();
    expect(historico.size).toBe(250);
    expect([...historico.values()].every((n) => n === 1)).toBe(true);
    const linhas = await prisma.notification.findMany({
      where: { userId: { in: usuarios.map((u) => u.id) } },
      select: { userId: true, expoPushToken: true, title: true },
    });
    for (const linha of linhas) {
      expect(linha.expoPushToken).toBe(tokenDe(linha.userId));
      expect(linha.title).toBe(`${MARCA} 250`);
    }
    // Cada entrega com o SEU resultado.
    const entregas = await prisma.pushEntrega.findMany({
      where: { disparoId: criado.disparoId },
    });
    expect(entregas).toHaveLength(250);
    for (const entrega of entregas) {
      expect(entrega).toMatchObject({
        estado: 'ENVIADA',
        ticketId: `ticket-${tokenDe(entrega.userId)}`,
        tentativas: 1,
        erro: null,
      });
      expect(entrega.enviadaEm).toBeInstanceOf(Date);
    }
    // Disparo e log do painel fechados com as contagens reais.
    expect(await repo.buscarDisparo(criado.disparoId)).toMatchObject({
      estado: 'CONCLUIDO',
      totalDestinatarios: 250,
      totalEnviadas: 250,
      totalRecusadas: 0,
      totalFalhas: 0,
    });
    expect(
      await prisma.marketingNotificationAuditLog.findUnique({
        where: { id: criado.auditId },
      }),
    ).toMatchObject({ status: 'SENT', sentCount: 250, skippedCount: 0 });
    // A consulta de recibos ficou agendada (job atrasado, id determinístico).
    const jobDeRecibos = await fila.getJob(
      jobIdDosRecibos(criado.disparoId, 1),
    );
    expect(await jobDeRecibos?.getState()).toBe('delayed');
  });

  it('lote do meio com falha de transporte: o BullMQ repete o job e só os 100 dele são reenviados, sem duplicar ninguém', async () => {
    const tokenDoMeio = tokenDe(usuarios[150].id);
    let falhasDoMeio = 0;
    gateway.responder = (mensagens) => {
      // O lote que contém o usuário 151 fica sem resposta duas vezes.
      if (mensagens.some((m) => m.to === tokenDoMeio) && falhasDoMeio < 2) {
        falhasDoMeio++;
        return PushGatewayFalso.semResposta(mensagens);
      }
      return PushGatewayFalso.aceitarTudo(mensagens);
    };

    const criado = await disparar('falha no meio', 250);
    await esperar(concluido(criado.disparoId));

    expect(falhasDoMeio).toBe(2);
    // 250 + duas tentativas perdidas de 100: nenhum lote alheio foi reenviado.
    const mensagensDoDisparo = gateway.chamadas
      .flat()
      .filter((m) => m.title === `${MARCA} falha no meio`);
    expect(mensagensDoDisparo).toHaveLength(450);
    const aceitos = new Map(aceitosDosMeusTokens());
    for (const usuario of usuarios) {
      expect(aceitos.get(tokenDe(usuario.id))).toBe(1);
    }
    const historico = await historicoPorUsuario();
    expect(historico.size).toBe(250);
    expect([...historico.values()].every((n) => n === 1)).toBe(true);

    const entregas = await prisma.pushEntrega.findMany({
      where: { disparoId: criado.disparoId },
      orderBy: { id: 'asc' },
    });
    expect(entregas.every((e) => e.estado === 'ENVIADA')).toBe(true);
    expect(entregas.slice(0, 100).every((e) => e.tentativas === 1)).toBe(true);
    expect(entregas.slice(100, 200).every((e) => e.tentativas === 3)).toBe(
      true,
    );
    expect(entregas.slice(200).every((e) => e.tentativas === 1)).toBe(true);
    expect(
      await prisma.marketingNotificationAuditLog.findUnique({
        where: { id: criado.auditId },
      }),
    ).toMatchObject({ status: 'SENT', sentCount: 250, skippedCount: 0 });
  });

  it('o mesmo job executado de novo (reentrega, "stalled") não reenvia nem duplica o histórico', async () => {
    const criado = await disparar('reexecucao', 120);
    await esperar(concluido(criado.disparoId));
    const enviadas = gateway.chamadas.flat().length;
    const pagina = await paginaInteira(criado.disparoId);

    // Direto e pela fila (job novo para a mesma página).
    await expect(
      lotes.processar({ ...pagina, ateId: pagina.deId + 99 }),
    ).resolves.toMatchObject({ enviadas: 0, ignorado: 'CONCLUIDO' });
    const repetido = await fila.add('push-lote', {
      ...pagina,
      ateId: pagina.deId + 99,
    });
    await esperar(async () => (await repetido.getState()) === 'completed');

    expect(gateway.chamadas.flat()).toHaveLength(enviadas);
    const historico = await historicoPorUsuario();
    expect(historico.size).toBe(120);
    expect([...historico.values()].every((n) => n === 1)).toBe(true);
  });

  it('lote reexecutado com o disparo AINDA em envio só manda o que está aberto', async () => {
    const disparo = await disparoSemFila(60);
    const pagina = await paginaInteira(disparo.id);
    // Primeira execução: os 20 primeiros aceitos, os outros 40 sem resposta.
    const primeiros = new Set(destinatarios(20).map((d) => d.expoPushToken));
    gateway.responder = (mensagens) =>
      mensagens.map((m) =>
        primeiros.has(m.to)
          ? { status: 'ok', ticketId: `ticket-${m.to}` }
          : { status: 'falha_transporte', mensagem: 'timeout' },
      );
    await expect(lotes.processar(pagina)).rejects.toMatchObject({
      vendor: 'expo',
      transitoria: true,
    });
    expect(
      await prisma.pushEntrega.groupBy({
        by: ['estado'],
        where: { disparoId: disparo.id },
        _count: { _all: true },
        orderBy: { estado: 'asc' },
      }),
    ).toEqual([
      { estado: 'ENVIADA', _count: { _all: 20 } },
      { estado: 'FALHA', _count: { _all: 40 } },
    ]);

    gateway.responder = PushGatewayFalso.aceitarTudo;
    gateway.chamadas.length = 0;
    await lotes.processar(pagina);

    expect(gateway.chamadas.flat()).toHaveLength(40);
    expect(gateway.chamadas.flat().some((m) => primeiros.has(m.to))).toBe(
      false,
    );
    const historico = await historicoPorUsuario();
    expect(historico.size).toBe(60);
    expect([...historico.values()].every((n) => n === 1)).toBe(true);
    expect((await repo.buscarDisparo(disparo.id))?.estado).toBe('CONCLUIDO');
  });

  it('duas execuções simultâneas do mesmo lote: a trava no Redis deixa UMA enviar', async () => {
    const disparo = await disparoSemFila(100);
    const pagina = await paginaInteira(disparo.id);
    gateway.atrasoMs = 300;

    const resultados = await Promise.allSettled([
      lotes.processar(pagina),
      lotes.processar(pagina),
    ]);

    expect(resultados.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const recusada = resultados.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(recusada?.reason).toBeInstanceOf(LoteEmExecucaoError);
    expect(gateway.chamadas.flat()).toHaveLength(100);
    expect(
      await prisma.notification.count({
        where: { userId: { in: usuarios.map((u) => u.id) } },
      }),
    ).toBe(100);
  });

  it('sem a trava (dois processos gravando o MESMO resultado): o UPDATE condicional garante uma linha de histórico por entrega', async () => {
    const disparo = await disparoSemFila(80);
    const entregas = await repo.entregasDaPagina(
      disparo.id,
      await paginaInteira(disparo.id),
    );
    const resultado: ResultadoDoLote = {
      aceitas: entregas.map((e) => ({ ...e, ticketId: `t-${e.id}` })),
      recusadas: [],
      falhas: [],
    };

    const [a, b] = await Promise.all([
      repo.gravarResultadoDoLote(disparo, resultado, new Date()),
      repo.gravarResultadoDoLote(disparo, resultado, new Date()),
    ]);

    expect(a.enviadas + b.enviadas).toBe(80);
    expect(
      await prisma.notification.count({
        where: { userId: { in: usuarios.map((u) => u.id) } },
      }),
    ).toBe(80);
    expect((await repo.buscarDisparo(disparo.id))?.totalEnviadas).toBe(80);
  });

  it('token morto é apagado do usuário; token trocado no meio do caminho não', async () => {
    const disparo = await disparoSemFila(4);
    const [morto, trocou, grande, normal] = usuarios.slice(0, 4);
    const tokenNovo = `ExponentPushToken[${MARCA}-novo]`;
    // Depois da seleção, o segundo usuário reinstalou o app.
    await prisma.user.update({
      where: { id: trocou.id },
      data: { expoPushToken: tokenNovo },
    });
    gateway.responder = (mensagens) =>
      mensagens.map((m) => {
        if (m.to === tokenDe(morto.id) || m.to === tokenDe(trocou.id)) {
          return {
            status: 'recusado',
            mensagem: 'não registrado',
            detalhe: 'DeviceNotRegistered',
          };
        }
        if (m.to === tokenDe(grande.id)) {
          return {
            status: 'recusado',
            mensagem: 'grande',
            detalhe: 'MessageTooBig',
          };
        }
        return { status: 'ok', ticketId: `ticket-${m.to}` };
      });

    await expect(
      lotes.processar(await paginaInteira(disparo.id)),
    ).resolves.toEqual({ enviadas: 1, recusadas: 3, falhas: 0 });

    const token = async (id: number) =>
      (await prisma.user.findUnique({ where: { id } }))?.expoPushToken;
    expect(await token(morto.id)).toBeNull();
    expect(await token(trocou.id)).toBe(tokenNovo);
    expect(await token(grande.id)).toBe(tokenDe(grande.id));
    expect(await token(normal.id)).toBe(tokenDe(normal.id));
    expect(
      (
        await prisma.pushEntrega.findMany({
          where: { disparoId: disparo.id, estado: 'RECUSADA' },
          orderBy: { id: 'asc' },
        })
      ).map((e) => e.erro),
    ).toEqual([
      'DeviceNotRegistered: não registrado',
      'DeviceNotRegistered: não registrado',
      'MessageTooBig: grande',
    ]);
    // Só o aceito ganhou histórico.
    expect([...(await historicoPorUsuario()).keys()]).toEqual([normal.id]);
    expect(await repo.buscarDisparo(disparo.id)).toMatchObject({
      estado: 'CONCLUIDO',
      totalEnviadas: 1,
      totalRecusadas: 3,
    });
  });

  it('recibos: ENVIADA vira ENTREGUE ou RECUSADA, e o recibo de token morto apaga o token', async () => {
    const disparo = await disparoSemFila(3);
    await lotes.processar(await paginaInteira(disparo.id));
    const [entregue, morto, semRecibo] = usuarios.slice(0, 3);
    gateway.recibos = () => ({
      [`ticket-${tokenDe(entregue.id)}`]: { status: 'ok' },
      [`ticket-${tokenDe(morto.id)}`]: {
        status: 'erro',
        mensagem: 'não registrado',
        detalhe: 'DeviceNotRegistered',
      },
    });

    await expect(
      recibos.processar({ disparoId: disparo.id, passada: 1 }),
    ).resolves.toEqual({ entregues: 1, recusadas: 1, semRecibo: 1 });

    const estado = async (userId: number) =>
      (
        await prisma.pushEntrega.findFirst({
          where: { disparoId: disparo.id, userId },
        })
      )?.estado;
    expect(await estado(entregue.id)).toBe('ENTREGUE');
    expect(await estado(morto.id)).toBe('RECUSADA');
    expect(await estado(semRecibo.id)).toBe('ENVIADA');
    expect(
      (await prisma.user.findUnique({ where: { id: morto.id } }))
        ?.expoPushToken,
    ).toBeNull();
    // Faltou um recibo: nova passada agendada.
    expect(
      await (await fila.getJob(jobIdDosRecibos(disparo.id, 2)))?.getState(),
    ).toBe('delayed');
  });

  it('fechamento: de duas execuções ao mesmo tempo, só uma fecha (e o log é fechado uma vez)', async () => {
    const disparo = await disparoSemFila(2);
    await prisma.pushEntrega.updateMany({
      where: { disparoId: disparo.id },
      data: { estado: 'ENVIADA' },
    });

    const fechamentos = await Promise.all([
      lotes.tentarFechar(disparo.id),
      lotes.tentarFechar(disparo.id),
      lotes.tentarFechar(disparo.id),
    ]);

    expect(fechamentos.filter(Boolean)).toHaveLength(1);
    expect(await repo.buscarDisparo(disparo.id)).toMatchObject({
      estado: 'CONCLUIDO',
      totalEnviadas: 2,
    });
  });

  it('agendado: a reivindicação SCHEDULED → SENDING cria o disparo na mesma transação — duas execuções, UM disparo', async () => {
    const auditId = (await audit.createRequestAudit(
      adminId,
      { title: `${MARCA} agendado`, body: 'Corpo' },
      { agendarPara: new Date(Date.now() + 3_600_000) },
    )) as number;

    const reivindicacoes = await Promise.all([
      repo.reivindicarAgendado(auditId),
      repo.reivindicarAgendado(auditId),
      repo.reivindicarAgendado(auditId),
    ]);

    const ganhou = reivindicacoes.filter((d) => d !== null);
    expect(ganhou).toHaveLength(1);
    expect(ganhou[0]).toMatchObject({
      tipo: 'MARKETING',
      marketingAuditLogId: auditId,
      titulo: `${MARCA} agendado`,
      estado: 'CRIADO',
    });
    expect(
      await prisma.pushDisparo.count({
        where: { marketingAuditLogId: auditId },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.marketingNotificationAuditLog.findUnique({
          where: { id: auditId },
        })
      )?.status,
    ).toBe('SENDING');
    expect((await repo.disparoDoLog(auditId))?.id).toBe(ganhou[0].id);
  });

  it('varredura: disparo sem batimento aparece como parado, e de duas retomadas só uma assume', async () => {
    const disparo = await disparoSemFila(1);
    const daquiA20Min = new Date(Date.now() + 20 * 60_000);

    const parados = await repo.disparosParados(daquiA20Min, 500);
    const meu = parados.find((d) => d.id === disparo.id);
    if (!meu)
      throw new Error('o disparo sem batimento não apareceu como parado');
    // Com o limite no passado, o batimento recente o tira da lista.
    expect(
      (await repo.disparosParados(new Date(Date.now() - 60_000), 500)).some(
        (d) => d.id === disparo.id,
      ),
    ).toBe(false);

    const retomadas = await Promise.all([
      repo.reivindicarRetomada(meu, daquiA20Min),
      repo.reivindicarRetomada(meu, daquiA20Min),
    ]);
    expect(retomadas.filter(Boolean)).toHaveLength(1);

    // Vencido: o que estava aberto não sai mais e o disparo fecha como falho.
    expect(await repo.temAbertas(disparo.id)).toBe(true);
    expect(await repo.expirarAbertas(disparo.id)).toBe(1);
    expect(await repo.temAbertas(disparo.id)).toBe(false);
    expect(await lotes.tentarFechar(disparo.id)).toBe(true);
    expect(await repo.buscarDisparo(disparo.id)).toMatchObject({
      estado: 'FALHOU',
      totalEnviadas: 0,
      totalFalhas: 1,
    });
  });

  it('varredura: log aberto sem disparo é fechado como falho; log com disparo e log recente ficam', async () => {
    const criar = (titulo: string) =>
      audit.createRequestAudit(adminId, {
        title: `${MARCA} ${titulo}`,
        body: 'Corpo',
      });
    const orfao = (await criar('órfão')) as number;
    const comDisparo = (await criar('com disparo')) as number;
    const recente = (await criar('recente')) as number;
    const disparo = await repo.criarDisparo({
      tipo: 'MARKETING',
      titulo: `${MARCA} com disparo`,
      corpo: 'Corpo',
      dados: {},
      marketingAuditLogId: comDisparo,
    });
    disparosCriados.push(disparo.id);
    // Data bem antiga: o corte usado abaixo só alcança as linhas deste teste.
    await prisma.$executeRaw`UPDATE MarketingNotificationAuditLog SET updatedAt = '2001-01-01 00:00:00' WHERE id IN (${orfao}, ${comDisparo})`;

    const fechados = await repo.falharLogsOrfaos(
      new Date('2002-01-01T00:00:00Z'),
      new Date(),
    );

    expect(fechados).toBe(1);
    const status = async (id: number) =>
      (await prisma.marketingNotificationAuditLog.findUnique({ where: { id } }))
        ?.status;
    expect(await status(orfao)).toBe('FAILED');
    expect(await status(comDisparo)).toBe('REQUESTED');
    expect(await status(recente)).toBe('REQUESTED');
  });

  describe('disparo por planilha — uma execução por vez (trava real + banco real)', () => {
    const planilhaCom = async (total: number): Promise<Buffer> => {
      const workbook = new ExcelJS.Workbook();
      const aba = workbook.addWorksheet('CPFs');
      aba.addRow(['CPF']);
      usuarios.slice(0, total).forEach((u) => aba.addRow([u.cpf]));
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };

    it('dois envios iguais ao mesmo tempo e um terceiro em seguida: UM disparo, UM log, um push por destinatário', async () => {
      const pedido = {
        arquivo: await planilhaCom(30),
        title: `${MARCA} planilha`,
        body: 'Regularize o cadastro',
      };
      const contexto = { adminUserId: adminId };

      const simultaneos = await Promise.allSettled([
        planilha.dispararPorPlanilha(pedido, contexto),
        planilha.dispararPorPlanilha(pedido, contexto),
      ]);
      const terceiro = await planilha.dispararPorPlanilha(pedido, contexto);

      const criados = await prisma.pushDisparo.findMany({
        where: { titulo: `${MARCA} planilha` },
      });
      expect(criados).toHaveLength(1);
      expect(criados[0]).toMatchObject({
        tipo: 'SITUACAO_CADASTRO',
        totalDestinatarios: 30,
        dados: { type: 'internal_route', screen: 'financeiro' },
      });
      expect(
        await prisma.marketingNotificationAuditLog.count({
          where: { adminPanelUserId: adminId, title: `${MARCA} planilha` },
        }),
      ).toBe(1);
      // Quem chegou junto recebe 409 ou o disparo existente; nunca outro.
      expect(simultaneos.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const r of simultaneos) {
        if (r.status === 'fulfilled') {
          expect(r.value.disparoId).toBe(criados[0].id);
        } else {
          expect(r.reason).toMatchObject({
            code: 'DISPARO_EM_ANDAMENTO',
            status: 409,
          });
        }
      }
      expect(terceiro).toMatchObject({
        disparoId: criados[0].id,
        repetido: true,
        sentCount: 30,
        skippedCount: 0,
      });

      await esperar(concluido(criados[0].id));
      const historico = await historicoPorUsuario();
      expect(historico.size).toBe(30);
      expect([...historico.values()].every((n) => n === 1)).toBe(true);
      expect(
        await prisma.marketingNotificationAuditLog.findFirst({
          where: { adminPanelUserId: adminId, title: `${MARCA} planilha` },
        }),
      ).toMatchObject({
        tipo: 'SITUACAO_CADASTRO',
        status: 'SENT',
        sentCount: 30,
        skippedCount: 0,
      });
    });

    it('Idempotency-Key (tabela real): a repetição devolve a primeira resposta, mesmo fora da janela de repetição', async () => {
      const pedido = {
        arquivo: await planilhaCom(5),
        title: `${MARCA} planilha com chave`,
        body: 'Corpo',
      };
      const contexto = {
        adminUserId: adminId,
        chaveDeIdempotencia: `${MARCA}-chave-0001`,
      };

      const primeira = await planilha.dispararPorPlanilha(pedido, contexto);
      await esperar(concluido(primeira.disparoId));
      await prisma.pushDisparo.update({
        where: { id: primeira.disparoId },
        data: { criadoEm: new Date(Date.now() - 3_600_000) },
      });
      const repetida = await planilha.dispararPorPlanilha(pedido, contexto);

      expect(repetida).toEqual(primeira);
      expect(
        await prisma.pushDisparo.count({
          where: { titulo: `${MARCA} planilha com chave` },
        }),
      ).toBe(1);
    });
  });
});

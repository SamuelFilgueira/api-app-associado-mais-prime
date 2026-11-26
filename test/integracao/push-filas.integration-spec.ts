import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';
import { TravaService } from 'src/infra/redis/trava.service';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import {
  emLotesDePush,
  PushAvulso,
} from 'src/notifications/domain/push-avulsos';
import { NotificationProcessor } from 'src/notifications/processors/notification.processor';
import { PushMassaProcessor } from 'src/notifications/processors/push-massa.processor';
import { PushDisparoRepository } from 'src/notifications/repositories/push-disparo.repository';
import { AlertaVeiculoService } from 'src/notifications/services/alerta-veiculo.service';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import { PushAvulsosService } from 'src/notifications/services/push-avulsos.service';
import { PushLoteService } from 'src/notifications/services/push-lote.service';
import { PushRecibosService } from 'src/notifications/services/push-recibos.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';
import { PushUnitarioService } from 'src/notifications/services/push-unitario.service';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import {
  FILA_DE_MORTOS,
  NOTIFICATION_QUEUE,
  OPCOES_POR_FILA,
  PUSH_MASSA_QUEUE,
} from 'src/queue/filas';
import { comEnvelope } from 'src/queue/job-envelope';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import {
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  opcoesDoRedisDeTeste,
  redisDeTeste,
} from './ambiente';

const describeComBancoERedis =
  TEST_DATABASE_URL && TEST_REDIS_URL ? describe : describe.skip;

const MARCA = `it-pushfila-${process.pid}`;
const CHASSI = `${MARCA}-chassi`.slice(0, 100);

const esperar = async (condicao: () => Promise<boolean>, prazoMs = 25_000) => {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condição não atingida no prazo');
};

/**
 * Fila de alerta separada da fila de massa, com BullMQ e banco reais. Antes,
 * os lembretes do Associado da Sorte entravam às centenas na fila de alerta
 * e o aviso de ignição esperava atrás deles.
 */
describeComBancoERedis('Push — fila de alerta × fila de massa', () => {
  let modulo: TestingModule;
  let prisma: PrismaService;
  let redis: Redis;
  let gateway: PushGatewayFalso;
  let filaDeAlerta: Queue;
  let filaDeMassa: Queue;
  let mortos: Queue;
  let alertas: AlertaVeiculoService;

  let dono: { id: number; expoPushToken: string };
  let inscritos: Array<{ id: number; expoPushToken: string }>;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    redis = redisDeTeste();
    gateway = new PushGatewayFalso();

    // As 5 tentativas das filas de verdade, com a espera encurtada.
    const retryRapido = (
      fila: typeof NOTIFICATION_QUEUE | typeof PUSH_MASSA_QUEUE,
    ) => ({
      name: fila,
      defaultJobOptions: {
        ...OPCOES_POR_FILA[fila],
        backoff: { type: 'fixed', delay: 100 },
      },
    });
    modulo = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: opcoesDoRedisDeTeste(),
          prefix: `${MARCA}-filas`,
        }),
        BullModule.registerQueue(
          retryRapido(NOTIFICATION_QUEUE),
          retryRapido(PUSH_MASSA_QUEUE),
          { name: FILA_DE_MORTOS },
        ),
      ],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: PushGateway, useValue: gateway },
        { provide: REDIS_CLIENTE, useValue: redis },
        TravaService,
        FilaDeMortosService,
        ProdutorDeFilas,
        PushDisparoRepository,
        PushRecibosService,
        PushLoteService,
        PushAvulsosService,
        CaixaDeEntradaService,
        PushTokenService,
        PushUnitarioService,
        AlertaVeiculoService,
        NotificationProcessor,
        PushMassaProcessor,
      ],
    }).compile();
    modulo.useLogger(false);
    await modulo.init();

    filaDeAlerta = modulo.get(getQueueToken(NOTIFICATION_QUEUE));
    filaDeMassa = modulo.get(getQueueToken(PUSH_MASSA_QUEUE));
    mortos = modulo.get(getQueueToken(FILA_DE_MORTOS));
    alertas = modulo.get(AlertaVeiculoService);

    const token = (i: number) => `ExponentPushToken[${MARCA}-${i}]`;
    await prisma.user.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        name: `${MARCA}-${i}`,
        cpf: `8${String(process.pid % 100_000).padStart(5, '0')}${String(i).padStart(5, '0')}`,
        email: `${MARCA}-${i}@teste.local`,
        passwordHash: 'x',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: token(i),
        notificacaoIgnicao: i === 0,
      })),
    });
    const criados = await prisma.user.findMany({
      where: { email: { startsWith: `${MARCA}-` } },
      select: { id: true, expoPushToken: true },
      orderBy: { id: 'asc' },
    });
    [dono, ...inscritos] = criados as Array<{
      id: number;
      expoPushToken: string;
    }>;
    await prisma.userVehicle.create({
      data: { userId: dono.id, chassi: CHASSI, plate: 'ABC1D23' },
    });
  });

  afterAll(async () => {
    await filaDeAlerta.obliterate({ force: true });
    await filaDeMassa.obliterate({ force: true });
    await mortos.obliterate({ force: true });
    await modulo.close();
    // Veículo e caixa de entrada caem em cascata com o usuário.
    await prisma.user.deleteMany({
      where: { email: { startsWith: `${MARCA}-` } },
    });
    await prisma.$disconnect();
    await redis.quit();
  });

  beforeEach(async () => {
    gateway.limpar();
    await prisma.notification.deleteMany({
      where: { userId: { in: [dono.id, ...inscritos.map((u) => u.id)] } },
    });
    await prisma.user.update({
      where: { id: dono.id },
      data: { expoPushToken: dono.expoPushToken },
    });
  });

  const linhasDe = (userId: number) =>
    prisma.notification.count({ where: { userId } });

  it('os lembretes do Sorte ocupam a fila de massa; o alerta de ignição sai pela fila de alerta sem esperar atrás deles', async () => {
    // Cada chamada ao provedor leva 250 ms: 20 jobs de massa, 2 por vez,
    // seguram a fila de massa por ~2,5 s.
    gateway.atrasoMs = 250;
    const lembretes: PushAvulso[] = Array.from({ length: 100 }, (_, i) => ({
      userId: inscritos[i % inscritos.length].id,
      expoPushToken: inscritos[i % inscritos.length].expoPushToken,
      title: 'Sua raspadinha está liberada 🍀',
      body: 'Raspe agora',
      data: { type: 'internal_route', screen: 'associado-da-sorte' },
    }));
    // O mesmo formato que os services do Sorte enfileiram.
    await filaDeMassa.addBulk(
      emLotesDePush(lembretes, 5).map((lote) => ({
        name: 'sorte-lembrete-raspada',
        data: comEnvelope({ mensagens: lote }, 'MAIS_PRIME'),
      })),
    );
    expect((await filaDeAlerta.getJobCounts('waiting', 'active')).waiting).toBe(
      0,
    );

    // O rastreador avisa: ignição ligada.
    const inicio = Date.now();
    await expect(
      alertas.dispararNotificacaoVeiculoWebhook(CHASSI, 32, null),
    ).resolves.toEqual({ sent: 1, skipped: 0 });
    await esperar(async () => (await linhasDe(dono.id)) === 1);
    const esperaDoAlerta = Date.now() - inicio;

    // O alerta saiu com a fila de massa ainda cheia.
    const massa = await filaDeMassa.getJobCounts('waiting', 'active');
    expect(massa.waiting).toBeGreaterThanOrEqual(10);
    expect(esperaDoAlerta).toBeLessThan(1_500);
    const alerta = gateway.chamadas
      .flat()
      .filter((m) => m.to === dono.expoPushToken);
    expect(alerta).toHaveLength(1);
    expect(alerta[0]).toMatchObject({
      title: 'Ignição Ligada 🔑',
      body: 'A ignição do seu veículo (placa ABC1D23) foi ligada.',
      data: { chassi: CHASSI, ignition: 'on', eventType: 'ignition_on' },
    });

    // E a massa termina no tempo dela: os 100 lembretes, uma vez cada.
    await esperar(async () => {
      const c = await filaDeMassa.getJobCounts('waiting', 'active', 'delayed');
      return c.waiting + c.active + c.delayed === 0;
    });
    expect(
      gateway.chamadas.flat().filter((m) => m.body === 'Raspe agora'),
    ).toHaveLength(100);
    expect(
      await prisma.notification.count({
        where: { userId: { in: inscritos.map((u) => u.id) } },
      }),
    ).toBe(100);
  });

  it('job `sorte-*` no formato antigo, que já estava na fila de alerta antes do deploy, continua sendo atendido', async () => {
    const [inscrito] = inscritos;
    const antigo = await filaDeAlerta.add(
      'sorte-lembrete-raspada',
      comEnvelope(
        {
          userId: inscrito.id,
          expoPushToken: inscrito.expoPushToken,
          title: 'Sua raspadinha está liberada 🍀',
          body: 'Formato antigo',
          data: { type: 'internal_route', screen: 'associado-da-sorte' },
        },
        'MAIS_PRIME',
      ),
      // As opções com que esses jobs eram enfileirados.
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    );

    await esperar(async () => (await antigo.getState()) === 'completed');

    expect(
      gateway.chamadas.flat().filter((m) => m.body === 'Formato antigo'),
    ).toHaveLength(1);
    expect(await linhasDe(inscrito.id)).toBe(1);
  });

  it('push unitário: falha de transporte faz o job falhar e o BullMQ repetir — no fim, UM push aceito e UMA linha', async () => {
    let semResposta = 2;
    gateway.responder = (mensagens) => {
      if (semResposta > 0) {
        semResposta--;
        return PushGatewayFalso.semResposta(mensagens);
      }
      return PushGatewayFalso.aceitarTudo(mensagens);
    };

    await alertas.dispararNotificacaoVeiculoWebhook(CHASSI, 16, null);
    await esperar(async () => (await linhasDe(dono.id)) === 1);

    // Três chamadas ao provedor (duas perdidas), um push aceito, uma linha.
    expect(gateway.chamadas).toHaveLength(3);
    expect(gateway.aceitosPorToken().get(dono.expoPushToken)).toBe(1);
    expect(await linhasDe(dono.id)).toBe(1);
    expect((await mortos.getJobCounts('waiting')).waiting).toBe(0);
  });

  it('push unitário: recusa do Expo NÃO repete — o job conclui na primeira tentativa, o aviso fica na caixa de entrada e o token morto é apagado', async () => {
    gateway.responder = (mensagens) =>
      mensagens.map(() => ({
        status: 'recusado',
        mensagem: 'não registrado',
        detalhe: 'DeviceNotRegistered',
      }));

    const job = await filaDeAlerta.add(
      'push-avulso',
      comEnvelope(
        {
          userId: dono.id,
          expoPushToken: dono.expoPushToken,
          title: 'Aviso',
          body: 'Recusado',
          data: { type: 'aviso' },
        },
        'MAIS_PRIME',
      ),
    );
    await esperar(async () => (await job.getState()) === 'completed');

    const concluido = await filaDeAlerta.getJob(job.id as string);
    expect(concluido?.attemptsMade).toBe(1);
    expect(concluido?.returnvalue).toEqual({
      success: false,
      message: 'não registrado',
      notificationId: expect.any(Number),
    });
    expect(gateway.chamadas).toHaveLength(1);
    // O sino não depende do push: a linha existe mesmo com a recusa.
    expect(await linhasDe(dono.id)).toBe(1);
    expect(
      (await prisma.user.findUnique({ where: { id: dono.id } }))?.expoPushToken,
    ).toBeNull();
  });
});

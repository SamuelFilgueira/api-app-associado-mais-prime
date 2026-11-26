import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { metricas } from 'src/infra/observability/metricas';
import { TravaService } from 'src/infra/redis/trava.service';
import {
  Destinatario,
  LogExistente,
} from 'src/boleto-notificacao/domain/regua-elegibilidade';
import { metricasVazias } from 'src/boleto-notificacao/domain/regua-resultado';
import { ReguaExecucaoRepository } from 'src/boleto-notificacao/repositories/regua-execucao.repository';
import { ReguaLogRepository } from 'src/boleto-notificacao/repositories/regua-log.repository';
import {
  boletoSga,
  consultaSga,
  montarRegua,
} from 'src/boleto-notificacao/testing/montar-regua';
import {
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  describeComBanco,
  limparChaves,
  redisDeTeste,
} from './ambiente';

/** Base fictícia por execução da suíte: é o marcador de limpeza. */
const BASE = `IT_REGUA_${process.pid}`;

jest.mock('src/config/tenant.config', () => ({
  TENANT: { baseNames: ['MAIS_PRIME'], defaultBase: 'MAIS_PRIME' },
  isTenantBase: () => true,
}));

const DIA_10 = new Date(2026, 8, 10);
const VENCIMENTO = new Date('2026-09-10T00:00:00.000Z');
const cpfDe = (i: number) =>
  `7${String(process.pid % 100_000_000).padStart(8, '0')}${String(i).padStart(2, '0')}`;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Régua de boletos contra o MariaDB real: a unique de idempotência, as
 * transições com estado no `WHERE` (inclusive a guarda por `atualizadoEm`,
 * que depende da precisão do DATETIME) e a consulta que restaura o gauge.
 */
describeComBanco('Banco real — log e execuções da régua de boletos', () => {
  let prisma: PrismaService;
  let execucoes: ReguaExecucaoRepository;
  let logs: ReguaLogRepository;
  let usuarios: Array<{ id: number; cpf: string; expoPushToken: string }>;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    execucoes = new ReguaExecucaoRepository(prisma);
    logs = new ReguaLogRepository(prisma);

    usuarios = [];
    for (let i = 0; i < 3; i++) {
      const expoPushToken = `ExponentPushToken[it-regua-${process.pid}-${i}]`;
      const usuario = await prisma.user.create({
        data: {
          name: BASE,
          cpf: cpfDe(i),
          email: `${BASE}-${i}@teste.local`.toLowerCase(),
          passwordHash: 'x',
          baseOrigin: BASE,
          expoPushToken,
        },
      });
      usuarios.push({ id: usuario.id, cpf: usuario.cpf, expoPushToken });
    }
  });

  afterAll(async () => {
    // Logs saem em cascata com a execução; notificações, com o usuário.
    await prisma.boletoNotificacaoExecucao.deleteMany({
      where: { tenant: BASE },
    });
    await prisma.user.deleteMany({ where: { name: BASE, baseOrigin: BASE } });
    await prisma.$disconnect();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
    await prisma.boletoNotificacaoExecucao.deleteMany({
      where: { tenant: BASE },
    });
    await prisma.notification.deleteMany({
      where: { userId: { in: usuarios.map((u) => u.id) } },
    });
    for (const usuario of usuarios) {
      await prisma.user.update({
        where: { id: usuario.id },
        data: { expoPushToken: usuario.expoPushToken },
      });
    }
  });

  const abrirExecucao = () =>
    execucoes.abrir({
      tenant: BASE,
      tipo: 'D0',
      dataReferencia: DIA_10,
      dataAlvo: DIA_10,
      origem: 'MANUAL',
    });

  const destinatario = (indice = 0): Destinatario => ({
    codigoAssociado: 1000 + indice,
    cpf: usuarios[indice].cpf,
    vencimento: DIA_10,
    boletos: [boletoSga({ nossoNumero: String(9000 + indice) })] as never[],
    userId: usuarios[indice].id,
    expoPushToken: usuarios[indice].expoPushToken,
    titulo: 'Seu boleto vence hoje',
    corpo: 'corpo',
  });

  const boletosDaBase = () =>
    usuarios.map((u, i) =>
      boletoSga({
        nossoNumero: String(9000 + i),
        codigoAssociado: 1000 + i,
        cpf: u.cpf,
        veiculos: [{ codigo_veiculo: i, placa: `ITG${i}A00` }],
      }),
    );

  const logsDaBase = () =>
    prisma.boletoNotificacaoLog.findMany({
      where: { tenant: BASE },
      orderBy: { codigoAssociado: 'asc' },
    });

  const opcoes = {
    dataReferencia: DIA_10,
    tenants: [BASE],
    tipos: ['D0' as const],
  };

  describe('unique de idempotência', () => {
    it('o segundo registro do mesmo associado × vencimento × etapa é barrado pelo banco', async () => {
      const contexto = {
        execucaoId: await abrirExecucao(),
        tenant: BASE,
        tipo: 'D0' as const,
      };

      expect(await logs.criar(contexto, destinatario())).toEqual(
        expect.any(Number),
      );
      expect(await logs.criar(contexto, destinatario())).toBeNull();
      // Outra etapa do mesmo vencimento é outro envio.
      expect(
        await logs.criar({ ...contexto, tipo: 'D1' }, destinatario()),
      ).toEqual(expect.any(Number));
    });

    it('cinco execuções gravando o mesmo envio ao mesmo tempo: só uma grava', async () => {
      const execucaoId = await abrirExecucao();

      const ids = await Promise.all(
        Array.from({ length: 5 }, () =>
          logs.criar({ execucaoId, tenant: BASE, tipo: 'D0' }, destinatario()),
        ),
      );

      expect(ids.filter((id) => id !== null)).toHaveLength(1);
      expect(await logsDaBase()).toHaveLength(1);
    });
  });

  describe('transições com o estado no WHERE', () => {
    async function logEnfileirado() {
      const execucaoId = await abrirExecucao();
      const id = (await logs.criar(
        { execucaoId, tenant: BASE, tipo: 'D0' },
        destinatario(),
      )) as number;
      return { execucaoId, id };
    }
    const lerExistente = async (): Promise<LogExistente> =>
      (await logs.buscarExistentes(BASE, 'D0', [destinatario()]))[0];

    it('marcarEnviado só vale para a execução dona e uma única vez', async () => {
      const { execucaoId, id } = await logEnfileirado();

      expect(await logs.marcarEnviado(id, execucaoId + 1, 'de-outra')).toBe(
        false,
      );
      expect(await logs.marcarEnviado(id, execucaoId, 'ticket-1')).toBe(true);
      expect(await logs.marcarEnviado(id, execucaoId, 'ticket-2')).toBe(false);
      expect((await logsDaBase())[0]).toMatchObject({
        statusEnvio: 'ENVIADO',
        expoTicketId: 'ticket-1',
      });
    });

    it('retomar: a guarda por atualizadoEm sobrevive à ida e volta no DATETIME do banco; duas retomadas simultâneas, só uma pega', async () => {
      const { id } = await logEnfileirado();
      const lido = await lerExistente();
      expect(lido).toMatchObject({ id, statusEnvio: 'ENFILEIRADO' });
      expect(lido.atualizadoEm).toBeInstanceOf(Date);
      const execucaoA = await abrirExecucao();
      const execucaoB = await abrirExecucao();

      const [a, b] = await Promise.all([
        logs.retomar(
          { execucaoId: execucaoA, tenant: BASE, tipo: 'D0' },
          destinatario(),
          lido,
        ),
        new ReguaLogRepository(prisma).retomar(
          { execucaoId: execucaoB, tenant: BASE, tipo: 'D0' },
          destinatario(),
          lido,
        ),
      ]);

      expect([a, b].sort()).toEqual([false, true]);
      const [linha] = await logsDaBase();
      expect(linha.execucaoId).toBe(a ? execucaoA : execucaoB);
      expect(linha.statusEnvio).toBe('ENFILEIRADO');
      // Retrato antigo não serve mais: a linha foi tocada.
      expect(
        await logs.retomar(
          { execucaoId: execucaoA, tenant: BASE, tipo: 'D0' },
          destinatario(),
          lido,
        ),
      ).toBe(false);
    });

    it('falha de transporte: só a execução dona retoma, e só o que é SEND_ERROR', async () => {
      const { execucaoId, id } = await logEnfileirado();
      await logs.marcarFalhaDeEnvio([id], execucaoId, 'SEND_ERROR: timeout');

      expect(await logs.retomarFalhaDeTransporte(id, execucaoId + 1)).toBe(
        false,
      );
      expect(await logs.retomarFalhaDeTransporte(id, execucaoId)).toBe(true);
      expect((await logsDaBase())[0]).toMatchObject({
        statusEnvio: 'ENFILEIRADO',
        expoErro: null,
      });

      await logs.marcarFalhaDeEnvio(
        [id],
        execucaoId,
        'DeviceNotRegistered: sem o app',
      );
      expect(await logs.retomarFalhaDeTransporte(id, execucaoId)).toBe(false);
    });

    it('execução: concluir e falhar só valem a partir de EM_ANDAMENTO', async () => {
      const id = await abrirExecucao();
      const metricasDaEtapa = {
        ...metricasVazias(),
        totalEnfileirados: 3,
        totalEnviados: 3,
        coberturaElegiveis: 1,
      };

      expect(await execucoes.concluir(id, metricasDaEtapa)).toBe(true);
      expect(await execucoes.concluir(id, metricasDaEtapa)).toBe(false);
      expect(await execucoes.falhar(id, 'tarde demais', metricasDaEtapa)).toBe(
        false,
      );
      expect(
        await prisma.boletoNotificacaoExecucao.findUnique({ where: { id } }),
      ).toMatchObject({ status: 'CONCLUIDA', erro: null, totalEnviados: 3 });
    });
  });

  describe('régua inteira sobre o banco real', () => {
    function montar() {
      const montagem = montarRegua({ prisma });
      montagem.sgaClient.listarAbertosPorVencimento.mockResolvedValue(
        consultaSga(boletosDaBase()),
      );
      return montagem;
    }

    it('envia, grava o ticket de cada um e a reexecução no mesmo dia não reenvia', async () => {
      const { service, expo } = montar();

      const [primeira] = await service.executarRotina(opcoes);
      const [segunda] = await service.executarRotina(opcoes);

      expect(primeira.metricas).toMatchObject({
        totalEnfileirados: 3,
        totalEnviados: 3,
      });
      expect(segunda.metricas).toMatchObject({
        totalIdempotentes: 3,
        totalEnfileirados: 0,
        totalEnviados: 0,
      });
      expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
      expect(
        (await logsDaBase()).map((l) => [l.statusEnvio, l.expoTicketId]),
      ).toEqual(usuarios.map((u) => ['ENVIADO', `ticket:${u.expoPushToken}`]));
      expect(
        await prisma.notification.count({
          where: { userId: { in: usuarios.map((u) => u.id) } },
        }),
      ).toBe(3);
    });

    it('quem caiu no meio: o órfão ENFILEIRADO antigo é reenviado na mesma linha; o ENVIADO e a recusa definitiva, não', async () => {
      const { service, expo } = montar();
      const execucaoMorta = await abrirExecucao();
      const contexto = {
        execucaoId: execucaoMorta,
        tenant: BASE,
        tipo: 'D0' as const,
      };
      const orfao = (await logs.criar(contexto, destinatario(0))) as number;
      const enviado = (await logs.criar(contexto, destinatario(1))) as number;
      const recusado = (await logs.criar(contexto, destinatario(2))) as number;
      await logs.marcarEnviado(enviado, execucaoMorta, 'ticket-antigo');
      await logs.marcarFalhaDeEnvio(
        [recusado],
        execucaoMorta,
        'DeviceNotRegistered: sem o app',
      );
      // O processo caiu há 20 minutos, entre gravar e enviar.
      const haVinteMinutos = new Date(Date.now() - 20 * 60_000);
      await prisma.boletoNotificacaoLog.updateMany({
        where: { execucaoId: execucaoMorta },
        data: { atualizadoEm: haVinteMinutos },
      });

      const [resultado] = await service.executarRotina(opcoes);

      expect(resultado.metricas).toMatchObject({
        totalIdempotentes: 2,
        totalReenvios: 1,
        totalEnfileirados: 1,
        totalEnviados: 1,
        totalPendentes: 0,
      });
      expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
      expect(
        (
          expo.sendPushNotificationsAsync.mock.calls[0][0] as Array<{
            to: string;
          }>
        ).map((m) => m.to),
      ).toEqual([usuarios[0].expoPushToken]);
      const linhas = await logsDaBase();
      expect(linhas.map((l) => l.id)).toEqual([orfao, enviado, recusado]);
      expect(linhas[0]).toMatchObject({
        execucaoId: resultado.execucaoId,
        statusEnvio: 'ENVIADO',
        expoTicketId: `ticket:${usuarios[0].expoPushToken}`,
      });
      expect(linhas[1]).toMatchObject({
        execucaoId: execucaoMorta,
        statusEnvio: 'ENVIADO',
        expoTicketId: 'ticket-antigo',
      });
      expect(linhas[2]).toMatchObject({
        execucaoId: execucaoMorta,
        statusEnvio: 'FALHA',
        expoErro: 'DeviceNotRegistered: sem o app',
      });
    });

    it('órfão ainda recente: não é reenviado agora e fica pendente', async () => {
      const { service, expo } = montar();
      const execucaoViva = await abrirExecucao();
      for (let i = 0; i < 3; i++) {
        await logs.criar(
          { execucaoId: execucaoViva, tenant: BASE, tipo: 'D0' },
          destinatario(i),
        );
      }

      const [resultado] = await service.executarRotina(opcoes);

      expect(resultado.metricas).toMatchObject({
        totalIdempotentes: 3,
        totalEnviados: 0,
        totalPendentes: 3,
      });
      expect(expo.sendPushNotificationsAsync).not.toHaveBeenCalled();
    });

    it('recibos: ENTREGUE pelo ticket de cada log e token morto apagado do usuário', async () => {
      const { service, receipts, expo } = montar();
      const [resultado] = await service.executarRotina(opcoes);
      expo.getPushNotificationReceiptsAsync.mockResolvedValue({
        [`ticket:${usuarios[0].expoPushToken}`]: { status: 'ok' },
        [`ticket:${usuarios[1].expoPushToken}`]: {
          status: 'error',
          message: 'sem o app',
          details: { error: 'DeviceNotRegistered' },
        },
      });

      const recibos = await receipts.verificarExecucao(
        resultado.execucaoId as number,
      );

      expect(recibos).toMatchObject({
        verificados: 2,
        entregues: 1,
        falhas: 1,
        tokensInvalidos: 1,
        pendentes: 1,
      });
      expect((await logsDaBase()).map((l) => l.statusEnvio)).toEqual([
        'ENTREGUE',
        'FALHA',
        'ENVIADO',
      ]);
      expect(
        (
          await prisma.user.findMany({
            where: { id: { in: usuarios.map((u) => u.id) } },
            orderBy: { id: 'asc' },
            select: { expoPushToken: true },
          })
        ).map((u) => u.expoPushToken),
      ).toEqual([usuarios[0].expoPushToken, null, usuarios[2].expoPushToken]);
      expect(
        await prisma.boletoNotificacaoExecucao.findUnique({
          where: { id: resultado.execucaoId as number },
          select: {
            totalEntregues: true,
            totalFalhas: true,
            totalTokensInvalidos: true,
            coberturaEntrega: true,
          },
        }),
      ).toEqual({
        totalEntregues: 1,
        totalFalhas: 1,
        totalTokensInvalidos: 1,
        coberturaEntrega: 0.3333,
      });
    });
  });

  describe('gauge restaurado no boot a partir do banco', () => {
    it('última execução CONCLUIDA da base; FALHA e EM_ANDAMENTO mais recentes não contam', async () => {
      const criar = (status: string, finalizadoEm: Date | null) =>
        prisma.boletoNotificacaoExecucao.create({
          data: {
            tenant: BASE,
            tipoMensagem: 'D0',
            dataReferencia: VENCIMENTO,
            dataAlvo: VENCIMENTO,
            status: status as never,
            finalizadoEm,
          },
        });
      await criar('CONCLUIDA', new Date('2026-09-09T14:05:00.000Z'));
      await criar('CONCLUIDA', new Date('2026-09-10T14:07:30.000Z'));
      await criar('FALHA', new Date('2026-09-11T14:00:00.000Z'));
      await criar('EM_ANDAMENTO', null);

      const ultimas = await execucoes.ultimaConclusaoPorBase([
        BASE,
        `${BASE}_SEM_EXECUCAO`,
      ]);

      expect(Array.from(ultimas.keys())).toEqual([BASE]);
      expect(ultimas.get(BASE)?.toISOString()).toBe('2026-09-10T14:07:30.000Z');

      // O serviço de métrica publica esse instante, em segundos.
      metricas.boletoReguaUltimaExecucao.reset();
      const { metrica } = montarRegua({
        prisma,
        config: { get: () => ({ tenants: [BASE] }) },
      });
      await metrica.restaurar();
      const { values } = await metricas.boletoReguaUltimaExecucao.get();
      expect(values).toEqual([
        {
          labels: { base: BASE },
          value: Date.parse('2026-09-10T14:07:30.000Z') / 1000,
        },
      ]);
    });
  });

  const describeComRedisTambem = TEST_REDIS_URL ? describe : describe.skip;

  describeComRedisTambem('com a trava de verdade (Redis real)', () => {
    let redisA: Redis;
    let redisB: Redis;

    beforeAll(() => {
      redisA = redisDeTeste();
      redisB = redisDeTeste();
    });

    afterAll(async () => {
      await limparChaves(redisA, `trava:boleto-regua:${BASE}`);
      await redisA.quit();
      await redisB.quit();
    });

    it('dois processos executando a mesma base/data juntos: cada associado recebe UM push e há um log por envio', async () => {
      const processos = [redisA, redisB].map((redis) => {
        const montagem = montarRegua({
          prisma,
          trava: new TravaService(redis),
        });
        montagem.aguardar.mockImplementation(() => dormir(20));
        montagem.sgaClient.listarAbertosPorVencimento.mockImplementation(
          async () => {
            await dormir(400);
            return consultaSga(boletosDaBase());
          },
        );
        return montagem;
      });

      const [ra, rb] = await Promise.all(
        processos.map((p) => p.service.executarRotina(opcoes)),
      );

      expect([ra[0].status, rb[0].status].sort()).toEqual([
        'CONCLUIDA',
        'PULADA',
      ]);
      const pushes = processos.flatMap((p) =>
        p.expo.sendPushNotificationsAsync.mock.calls.flatMap((c) =>
          (c[0] as Array<{ to: string }>).map((m) => m.to),
        ),
      );
      expect(pushes.sort()).toEqual(
        usuarios.map((u) => u.expoPushToken).sort(),
      );
      expect(await logsDaBase()).toHaveLength(3);
      expect(
        await prisma.boletoNotificacaoExecucao.count({
          where: { tenant: BASE },
        }),
      ).toBe(1);
    });
  });
});

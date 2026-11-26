import { Job } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import {
  PushAvulso,
  PushAvulsosJobData,
} from 'src/notifications/domain/push-avulsos';
import { PushMassaProcessor } from 'src/notifications/processors/push-massa.processor';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import { PushAvulsosService } from 'src/notifications/services/push-avulsos.service';
import { PushLoteService } from 'src/notifications/services/push-lote.service';
import { PushRecibosService } from 'src/notifications/services/push-recibos.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { IntegrationError } from 'src/shared/erros/erros';

/**
 * Pushes avulsos em lote (lembretes do Associado da Sorte) na fila de massa:
 * um job = uma chamada ao provedor para até 100 mensagens.
 */
describe('pushes avulsos em lote (fila de massa)', () => {
  const token = (n: number) => `ExponentPushToken[usuario-${n}]`;
  const mensagens = (total: number): PushAvulso[] =>
    Array.from({ length: total }, (_, i) => ({
      userId: i + 1,
      expoPushToken: token(i + 1),
      title: 'Sua raspadinha está liberada',
      body: 'Raspe agora',
      data: { type: 'internal_route', screen: 'associado-da-sorte' },
    }));

  function montar() {
    const tokens = new Map<number, string | null>();
    const linhas: Array<{ userId: number; expoPushToken: string }> = [];
    const prisma = {
      user: {
        findMany: jest.fn(({ where }: { where: { id: { in: number[] } } }) =>
          Promise.resolve(where.id.in.map((id) => ({ id }))),
        ),
        updateMany: jest.fn(
          ({ where }: { where: { id: number; expoPushToken: string } }) => {
            const casa = tokens.get(where.id) === where.expoPushToken;
            if (casa) tokens.set(where.id, null);
            return Promise.resolve({ count: casa ? 1 : 0 });
          },
        ),
      },
      notification: {
        createMany: jest.fn(
          ({
            data,
          }: {
            data: Array<{ userId: number; expoPushToken: string }>;
          }) => {
            linhas.push(...data);
            return Promise.resolve({ count: data.length });
          },
        ),
      },
    };
    const banco = prisma as unknown as PrismaService;
    const gateway = new PushGatewayFalso();
    const service = new PushAvulsosService(
      gateway,
      new CaixaDeEntradaService(banco),
      new PushTokenService(banco, gateway),
    );
    const lotes = { processar: jest.fn().mockResolvedValue({ enviadas: 1 }) };
    const recibos = {
      processar: jest.fn().mockResolvedValue({ entregues: 1 }),
    };
    const processor = new PushMassaProcessor(
      lotes as unknown as PushLoteService,
      recibos as unknown as PushRecibosService,
      service,
      { receber: jest.fn() } as unknown as FilaDeMortosService,
    );

    const criarJob = (nome: string, dados: unknown) => {
      const job = {
        id: '1',
        name: nome,
        queueName: 'push-massa',
        attemptsMade: 0,
        data: dados,
        updateData: jest.fn((novos: unknown) => {
          job.data = novos;
          return Promise.resolve();
        }),
      };
      return job;
    };
    const processar = (job: ReturnType<typeof criarJob>) =>
      processor.process(job as unknown as Job<unknown>);

    return {
      gateway,
      prisma,
      linhas,
      tokens,
      lotes,
      recibos,
      criarJob,
      processar,
    };
  }

  it('100 lembretes: UMA chamada ao provedor e uma linha na caixa de entrada por push aceito', async () => {
    const { gateway, linhas, criarJob, processar } = montar();

    const resultado = await processar(
      criarJob('sorte-lembrete-raspada', { mensagens: mensagens(100) }),
    );

    expect(resultado).toEqual({ aceitos: 100, recusados: 0, invalidos: 0 });
    expect(gateway.chamadas).toHaveLength(1);
    expect(gateway.chamadas[0]).toHaveLength(100);
    expect(gateway.chamadas[0][0]).toMatchObject({
      to: token(1),
      title: 'Sua raspadinha está liberada',
      data: { type: 'internal_route', screen: 'associado-da-sorte' },
      channelId: 'alerts_v2',
    });
    expect(linhas.map((l) => l.userId)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
  });

  it('falha de transporte: o job falha para repetir, e a nova tentativa manda cada push uma vez só', async () => {
    const { gateway, linhas, criarJob, processar } = montar();
    const job = criarJob('sorte-lembrete', { mensagens: mensagens(30) });
    gateway.responder = PushGatewayFalso.semResposta;

    await expect(processar(job)).rejects.toBeInstanceOf(IntegrationError);
    expect(linhas).toHaveLength(0);

    gateway.responder = PushGatewayFalso.aceitarTudo;
    await processar(job);

    const aceitos = gateway.aceitosPorToken();
    expect(aceitos.size).toBe(30);
    expect([...aceitos.values()].every((n) => n === 1)).toBe(true);
    expect(linhas).toHaveLength(30);
  });

  it('resposta parcial: só quem ficou sem resposta é reenviado na nova tentativa', async () => {
    const { gateway, linhas, criarJob, processar } = montar();
    const job = criarJob('sorte-ganhador', { mensagens: mensagens(4) });
    // Usuários 3 e 4 ficam sem resposta na primeira chamada.
    gateway.responder = (lote) =>
      lote.map((m) =>
        m.to === token(3) || m.to === token(4)
          ? { status: 'falha_transporte', mensagem: 'timeout' }
          : { status: 'ok', ticketId: `ticket-${m.to}` },
      );

    await expect(processar(job)).rejects.toBeInstanceOf(IntegrationError);
    // Quem foi aceito já tem a linha, e o progresso ficou no job.
    expect(linhas.map((l) => l.userId)).toEqual([1, 2]);
    expect((job.data as PushAvulsosJobData)._progresso).toEqual({
      resolvidos: [0, 1],
      semHistorico: [],
    });

    gateway.responder = PushGatewayFalso.aceitarTudo;
    await processar(job);

    expect(gateway.chamadas[1].map((m) => m.to)).toEqual([token(3), token(4)]);
    expect(linhas.map((l) => l.userId)).toEqual([1, 2, 3, 4]);
  });

  it('banco falha depois de o push sair: a nova tentativa grava a caixa de entrada sem mandar o push de novo', async () => {
    const { gateway, prisma, linhas, criarJob, processar } = montar();
    const job = criarJob('sorte-lembrete-raspada', { mensagens: mensagens(5) });
    prisma.notification.createMany.mockRejectedValueOnce(
      new Error('ECONNRESET: banco fora'),
    );

    await expect(processar(job)).rejects.toThrow('banco fora');
    expect((job.data as PushAvulsosJobData)._progresso).toEqual({
      resolvidos: [0, 1, 2, 3, 4],
      semHistorico: [0, 1, 2, 3, 4],
    });

    await processar(job);

    expect(gateway.totalDeMensagens()).toBe(5);
    expect(linhas).toHaveLength(5);
  });

  it('recusado não lança nem ganha linha; token morto é apagado, token inválido nem é enviado', async () => {
    const { gateway, linhas, tokens, criarJob, processar } = montar();
    const lote = mensagens(4);
    lote[3].expoPushToken = 'token-sem-formato';
    tokens.set(2, token(2));
    gateway.responder = (enviadas) =>
      enviadas.map((m) =>
        m.to === token(2)
          ? {
              status: 'recusado',
              mensagem: 'não registrado',
              detalhe: 'DeviceNotRegistered',
            }
          : { status: 'ok', ticketId: `ticket-${m.to}` },
      );

    const resultado = await processar(
      criarJob('sorte-lembrete-raspada', { mensagens: lote }),
    );

    expect(resultado).toEqual({ aceitos: 2, recusados: 1, invalidos: 1 });
    expect(gateway.chamadas[0]).toHaveLength(3);
    expect(linhas.map((l) => l.userId)).toEqual([1, 3]);
    expect(tokens.get(2)).toBeNull();
  });

  describe('PushMassaProcessor — roteamento', () => {
    it('`push-lote` e `push-recibos` vão para os seus casos de uso', async () => {
      const { lotes, recibos, criarJob, processar } = montar();

      await processar(
        criarJob('push-lote', { disparoId: 1, deId: 1, ateId: 9 }),
      );
      await processar(criarJob('push-recibos', { disparoId: 1, passada: 1 }));

      expect(lotes.processar).toHaveBeenCalledWith({
        disparoId: 1,
        deId: 1,
        ateId: 9,
      });
      expect(recibos.processar).toHaveBeenCalledWith({
        disparoId: 1,
        passada: 1,
      });
    });

    it('job desconhecido é erro definitivo (fila de mortos), não retry', async () => {
      const { criarJob, processar } = montar();

      const erro = await processar(criarJob('qualquer', { userId: 1 })).catch(
        (e: Error) => e,
      );

      expect((erro as Error).name).toBe('UnrecoverableError');
    });
  });
});

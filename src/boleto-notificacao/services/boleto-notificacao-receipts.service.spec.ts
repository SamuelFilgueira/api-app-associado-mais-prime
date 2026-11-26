/* eslint-disable @typescript-eslint/no-unsafe-argument -- o dublê do Prisma devolve registros soltos (ids e linhas sem tipo) */
/**
 * Verificação de recibos do Expo: caracterização do estado que ela deixa nos
 * logs, no usuário (token morto) e nas métricas de entrega da execução.
 */
import { Logger } from '@nestjs/common';
import { montarRegua } from 'src/boleto-notificacao/testing/montar-regua';

jest.mock('src/config/tenant.config', () => ({
  TENANT: {
    baseNames: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
    defaultBase: 'MAIS_PRIME',
  },
  isTenantBase: (v: unknown) => v === 'MAIS_PRIME' || v === 'MAIS_PRIME_RS',
}));

describe('BoletoNotificacaoReceiptsService', () => {
  beforeEach(() => {
    for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  /** Execução com 4 pushes aceitos (t1..t4), 1 sem ticket e 1 já em falha. */
  async function cenario() {
    const montagem = montarRegua();
    const { prisma } = montagem;
    const execucao = await prisma.boletoNotificacaoExecucao.create({
      data: {
        tenant: 'MAIS_PRIME',
        tipoMensagem: 'D0',
        status: 'CONCLUIDA',
        totalEnfileirados: 4,
      },
    });
    const usuarios = ['11111111111', '22222222222', '33333333333'].map((cpf) =>
      prisma.comUsuario(cpf),
    );
    const criarLog = (codigoAssociado: number, extras: object) =>
      prisma.boletoNotificacaoLog.create({
        data: {
          execucaoId: execucao.id,
          tenant: 'MAIS_PRIME',
          codigoAssociado,
          dataVencimentoOriginal: new Date('2026-09-10T00:00:00.000Z'),
          tipoMensagem: 'D0',
          statusEnvio: 'ENVIADO',
          ...extras,
        },
      });
    await criarLog(1, {
      userId: usuarios[0].id,
      expoPushToken: usuarios[0].expoPushToken,
      expoTicketId: 't1',
    });
    await criarLog(2, {
      userId: usuarios[1].id,
      expoPushToken: usuarios[1].expoPushToken,
      expoTicketId: 't2',
    });
    await criarLog(3, {
      userId: usuarios[2].id,
      expoPushToken: usuarios[2].expoPushToken,
      expoTicketId: 't3',
    });
    await criarLog(4, {
      userId: null,
      expoPushToken: null,
      expoTicketId: 't4',
    });
    await criarLog(5, { expoTicketId: null }); // aceito sem ticket: fora
    await criarLog(6, {
      statusEnvio: 'FALHA',
      expoErro: 'SEND_ERROR: socket hang up',
    });
    return { ...montagem, execucao, usuarios };
  }

  const estado = (prisma: { logs: Array<Record<string, unknown>> }) =>
    prisma.logs.map((l) => [l.codigoAssociado, l.statusEnvio, l.expoErro]);

  it('atualiza cada log pelo recibo do PRÓPRIO ticket, apaga o token morto e recalcula a entrega', async () => {
    const { receipts, prisma, expo, execucao, usuarios } = await cenario();
    expo.getPushNotificationReceiptsAsync.mockResolvedValue({
      t1: { status: 'ok' },
      t2: {
        status: 'error',
        message: 'aparelho sem o app',
        details: { error: 'DeviceNotRegistered' },
      },
      t3: { status: 'error', message: 'recusado' },
      // t4: o Expo ainda não processou
    });

    const resultado = await receipts.verificarExecucao(execucao.id);

    expect(expo.getPushNotificationReceiptsAsync).toHaveBeenCalledTimes(1);
    expect(expo.getPushNotificationReceiptsAsync).toHaveBeenCalledWith([
      't1',
      't2',
      't3',
      't4',
    ]);
    expect(resultado).toEqual({
      execucaoId: execucao.id,
      verificados: 3,
      entregues: 1,
      falhas: 2,
      tokensInvalidos: 1,
      pendentes: 1,
    });
    expect(estado(prisma)).toEqual([
      [1, 'ENTREGUE', null],
      [2, 'FALHA', 'DeviceNotRegistered: aparelho sem o app'],
      [3, 'FALHA', 'RECEIPT_ERROR: recusado'],
      [4, 'ENVIADO', null],
      [5, 'ENVIADO', null],
      [6, 'FALHA', 'SEND_ERROR: socket hang up'],
    ]);
    // Só o token recusado como morto sai do cadastro.
    expect(prisma.usuarios.map((u) => u.expoPushToken)).toEqual([
      usuarios[0].expoPushToken,
      null,
      usuarios[2].expoPushToken,
    ]);
    expect(prisma.execucoes[0]).toMatchObject({
      totalEntregues: 1,
      totalFalhas: 3,
      totalTokensInvalidos: 1,
      coberturaEntrega: 0.25,
    });
    expect(prisma.execucoes[0].receiptsVerificadosEm).toBeInstanceOf(Date);
  });

  it('token trocado depois do envio: o recibo de token morto não apaga o token novo', async () => {
    const { receipts, prisma, expo, execucao } = await cenario();
    prisma.usuarios[1].expoPushToken = 'ExponentPushToken[novo-aparelho]';
    expo.getPushNotificationReceiptsAsync.mockResolvedValue({
      t2: {
        status: 'error',
        message: 'aparelho sem o app',
        details: { error: 'DeviceNotRegistered' },
      },
    });

    await receipts.verificarExecucao(execucao.id);

    expect(prisma.usuarios[1].expoPushToken).toBe(
      'ExponentPushToken[novo-aparelho]',
    );
  });

  it('Expo sem resposta na consulta: os tickets ficam pendentes e nenhum log muda', async () => {
    const { receipts, prisma, expo, execucao } = await cenario();
    expo.getPushNotificationReceiptsAsync.mockRejectedValue(
      new Error('socket hang up'),
    );

    const resultado = await receipts.verificarExecucao(execucao.id);

    expect(resultado).toMatchObject({
      verificados: 0,
      entregues: 0,
      falhas: 0,
      pendentes: 4,
    });
    expect(estado(prisma).slice(0, 4)).toEqual([
      [1, 'ENVIADO', null],
      [2, 'ENVIADO', null],
      [3, 'ENVIADO', null],
      [4, 'ENVIADO', null],
    ]);
    expect(prisma.execucoes[0]).toMatchObject({
      totalEntregues: 0,
      totalFalhas: 1,
      coberturaEntrega: 0,
    });
  });

  it('segunda verificação não reprocessa o que já tem recibo', async () => {
    const { receipts, prisma, expo, execucao } = await cenario();
    expo.getPushNotificationReceiptsAsync.mockResolvedValue({
      t1: { status: 'ok' },
      t2: { status: 'ok' },
      t3: { status: 'ok' },
    });
    await receipts.verificarExecucao(execucao.id);

    expo.getPushNotificationReceiptsAsync.mockClear();
    expo.getPushNotificationReceiptsAsync.mockResolvedValue({
      t4: { status: 'ok' },
    });
    const segunda = await receipts.verificarExecucao(execucao.id);

    expect(expo.getPushNotificationReceiptsAsync).toHaveBeenCalledWith(['t4']);
    expect(segunda).toMatchObject({
      verificados: 1,
      entregues: 1,
      pendentes: 0,
    });
    expect(prisma.execucoes[0]).toMatchObject({
      totalEntregues: 4,
      coberturaEntrega: 1,
    });
  });

  it('execução inexistente: lança', async () => {
    const { receipts } = montarRegua();

    await expect(receipts.verificarExecucao(404)).rejects.toThrow(
      'Execução #404 não encontrada',
    );
  });
});

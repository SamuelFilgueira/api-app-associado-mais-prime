import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { loadBoletoNotificacaoConfig } from 'src/boleto-notificacao/config/boleto-notificacao.config';

jest.mock('src/config/tenant.config', () => ({
  TENANT: {
    baseNames: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
    defaultBase: 'MAIS_PRIME',
  },
}));

function boletoSga(overrides: Record<string, unknown> = {}) {
  return {
    nossoNumero: '1001',
    codigoAssociado: 55,
    nomeAssociado: 'Fulano',
    cpf: '52998224725',
    dataVencimento: '10/03/2026',
    dataVencimentoOriginal: '10/03/2026',
    codigoSituacaoBoleto: '2',
    situacaoBoleto: 'ABERTO',
    valorBoleto: '99.90',
    mesReferente: '03/2026',
    veiculos: [],
    ...overrides,
  };
}

describe('BoletoNotificacaoService', () => {
  const config = { get: () => loadBoletoNotificacaoConfig({}) };
  const sgaClient = { listarAbertosPorVencimentoOriginal: jest.fn() };
  const queue = { add: jest.fn() };
  const prisma: any = {
    boletoNotificacaoExecucao: { create: jest.fn(), update: jest.fn() },
    boletoNotificacaoLog: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findMany: jest.fn(), updateMany: jest.fn() },
    notification: { createMany: jest.fn() },
  };
  let service: BoletoNotificacaoService;

  beforeEach(() => {
    jest.clearAllMocks();
    let execId = 0;
    prisma.boletoNotificacaoExecucao.create.mockImplementation(() =>
      Promise.resolve({ id: ++execId }),
    );
    prisma.boletoNotificacaoExecucao.update.mockResolvedValue({});
    prisma.boletoNotificacaoLog.findMany.mockResolvedValue([]);
    let logId = 0;
    prisma.boletoNotificacaoLog.create.mockImplementation(() =>
      Promise.resolve({ id: ++logId }),
    );
    prisma.boletoNotificacaoLog.update.mockResolvedValue({});
    prisma.user.findMany.mockResolvedValue([]);
    prisma.notification.createMany.mockResolvedValue({ count: 0 });
    queue.add.mockResolvedValue({ id: 'job' });
    sgaClient.listarAbertosPorVencimentoOriginal.mockResolvedValue({
      boletos: [],
      totalRegistros: 0,
      numeroPaginas: 0,
      paginasConsultadas: 1,
      duplicadosEntrePaginas: 0,
      origem: 'SGA',
    });

    service = new BoletoNotificacaoService(
      prisma,
      config as any,
      sgaClient as any,
      queue as any,
    );
    // Evita chamadas reais ao Expo
    (service as any).expo = {
      chunkPushNotifications: (msgs: unknown[]) => [msgs],
      sendPushNotificationsAsync: jest.fn((msgs: unknown[]) =>
        Promise.resolve(
          msgs.map((_, i) => ({ status: 'ok', id: `ticket-${i}` })),
        ),
      ),
    };
  });

  it('pula o momento quando a data-alvo não é dia de gatilho (sem consultar o SGA)', async () => {
    // 11/03/2026: D0=11 (não), D5=06 (não), D6=05 (sim)
    const resultados = await service.executarRotina({
      dataReferencia: new Date(2026, 2, 11),
      tenants: ['MAIS_PRIME'],
      dryRun: true,
    });

    expect(resultados.map((r) => [r.tipo, r.dataAlvo, r.gatilho])).toEqual([
      ['D0', '11/03/2026', false],
      ['D5', '06/03/2026', false],
      ['D6', '05/03/2026', true],
    ]);
    expect(sgaClient.listarAbertosPorVencimentoOriginal).toHaveBeenCalledTimes(
      1,
    );
    expect(sgaClient.listarAbertosPorVencimentoOriginal).toHaveBeenCalledWith(
      'MAIS_PRIME',
      new Date(2026, 2, 5),
    );
  });

  it('agrega boletos por associado, aplica idempotência, tenant e token; envia e registra logs', async () => {
    sgaClient.listarAbertosPorVencimentoOriginal.mockResolvedValue({
      boletos: [
        boletoSga({
          nossoNumero: '1',
          codigoAssociado: 55,
          cpf: '52998224725',
        }),
        boletoSga({
          nossoNumero: '2',
          codigoAssociado: 55,
          cpf: '529.982.247-25',
        }), // 2º boleto do mesmo associado
        boletoSga({
          nossoNumero: '3',
          codigoAssociado: 66,
          cpf: '01234567890',
        }), // sem usuário
        boletoSga({
          nossoNumero: '4',
          codigoAssociado: 77,
          cpf: '11144477735',
        }), // já notificado
        boletoSga({
          nossoNumero: '5',
          codigoAssociado: 88,
          cpf: '98765432100',
        }), // sem token
        boletoSga({
          nossoNumero: '6',
          codigoAssociado: 99,
          cpf: '12345678909',
        }), // outro tenant
        boletoSga({
          nossoNumero: '7',
          codigoAssociado: 100,
          cpf: '52998224725',
          codigoSituacaoBoleto: '1',
        }), // pago → descartado
      ],
      totalRegistros: 7,
      numeroPaginas: 1,
      paginasConsultadas: 1,
      duplicadosEntrePaginas: 0,
      origem: 'SGA',
    });
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      },
      {
        id: 2,
        cpf: '11144477735',
        baseOrigin: null,
        expoPushToken: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]',
      },
      {
        id: 3,
        cpf: '98765432100',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: null,
      },
      {
        id: 4,
        cpf: '12345678909',
        baseOrigin: 'MAIS_PRIME_RS',
        expoPushToken: 'ExponentPushToken[cccccccccccccccccccccc]',
      },
    ]);
    prisma.boletoNotificacaoLog.findMany.mockResolvedValue([
      { codigoAssociado: 77 },
    ]);

    const [resultado] = await service.executarRotina({
      dataReferencia: new Date(2026, 2, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(resultado.status).toBe('CONCLUIDA');
    expect(resultado.metricas).toMatchObject({
      totalRegistrosSga: 7,
      totalBoletosElegiveis: 6,
      totalAssociados: 5,
      totalIdempotentes: 1,
      totalSemUsuario: 2, // associado 66 (sem cadastro) + 99 (outro tenant)
      totalSemToken: 1,
      totalEnfileirados: 1,
      totalEnviados: 1,
      totalFalhas: 0,
      coberturaElegiveis: 0.2,
    });

    // Um único push para o associado 55, agregando 2 boletos
    expect(prisma.boletoNotificacaoLog.create).toHaveBeenCalledTimes(1);
    const logCriado = prisma.boletoNotificacaoLog.create.mock.calls[0][0].data;
    expect(logCriado).toMatchObject({
      tenant: 'MAIS_PRIME',
      codigoAssociado: 55,
      cpf: '52998224725',
      userId: 1,
      quantidadeBoletos: 2,
      tipoMensagem: 'D0',
      statusEnvio: 'ENFILEIRADO',
      mensagemTitulo: 'Boleto disponível para pagamento',
    });
    expect(logCriado.mensagemEnviada).toContain('10/03/2026');
    expect(logCriado.dataVencimentoOriginal.toISOString()).toBe(
      '2026-03-10T00:00:00.000Z',
    );

    // Deep-link do push
    const enviados = (service as any).expo.sendPushNotificationsAsync.mock
      .calls[0][0];
    expect(enviados[0].data).toMatchObject({
      type: 'internal_route',
      screen: 'financeiro',
      tipoMensagem: 'D0',
    });

    // Log atualizado com ticket, histórico do app gravado, receipts agendados
    expect(prisma.boletoNotificacaoLog.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { statusEnvio: 'ENVIADO', expoTicketId: 'ticket-0' },
    });
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'verificar-receipts',
      { execucaoId: 1, tentativa: 1 },
      expect.objectContaining({ delay: 15 * 60_000 }),
    );
  });

  it('aceita datas no formato real do SGA (yyyy-mm-dd) e CNPJ no campo cpf', async () => {
    sgaClient.listarAbertosPorVencimentoOriginal.mockResolvedValue({
      boletos: [
        boletoSga({
          nossoNumero: '1',
          codigoAssociado: 69402,
          cpf: '58034733000127',
          dataVencimentoOriginal: '2026-03-10',
          dataVencimento: '2026-03-10',
        }),
        boletoSga({
          nossoNumero: '2',
          codigoAssociado: 55,
          cpf: '52998224725',
          dataVencimentoOriginal: '2026-03-10',
        }),
        boletoSga({
          nossoNumero: '3',
          codigoAssociado: 56,
          cpf: '15654718738',
          dataVencimentoOriginal: '2026-03-11',
        }), // outra data → descartado
      ],
      totalRegistros: 3,
      numeroPaginas: 1,
      paginasConsultadas: 1,
      duplicadosEntrePaginas: 0,
      origem: 'SGA',
    });
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      },
      {
        id: 2,
        cpf: '58034733000127',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]',
      },
    ]);

    const [resultado] = await service.executarRotina({
      dataReferencia: new Date(2026, 2, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
      dryRun: true,
    });

    expect(resultado.metricas).toMatchObject({
      totalBoletosElegiveis: 2,
      totalAssociados: 2,
      totalEnfileirados: 2,
    });
  });

  it('dry-run não grava nem envia, mas reporta a amostra', async () => {
    sgaClient.listarAbertosPorVencimentoOriginal.mockResolvedValue({
      boletos: [boletoSga()],
      totalRegistros: 1,
      numeroPaginas: 1,
      paginasConsultadas: 1,
      duplicadosEntrePaginas: 0,
      origem: 'MOCK',
    });
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      },
    ]);

    const [resultado] = await service.executarRotina({
      dataReferencia: new Date(2026, 2, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
      dryRun: true,
    });

    expect(resultado.status).toBe('DRY_RUN');
    expect(resultado.execucaoId).toBeNull();
    expect(resultado.amostraDestinatarios).toEqual([
      {
        codigoAssociado: 55,
        cpf: '529******25',
        userId: 1,
        quantidadeBoletos: 1,
        nossoNumero: '1001',
      },
    ]);
    expect(prisma.boletoNotificacaoExecucao.create).not.toHaveBeenCalled();
    expect(prisma.boletoNotificacaoLog.create).not.toHaveBeenCalled();
    expect(
      (service as any).expo.sendPushNotificationsAsync,
    ).not.toHaveBeenCalled();
  });

  it('ticket DeviceNotRegistered marca FALHA e invalida o token do usuário', async () => {
    sgaClient.listarAbertosPorVencimentoOriginal.mockResolvedValue({
      boletos: [boletoSga()],
      totalRegistros: 1,
      numeroPaginas: 1,
      paginasConsultadas: 1,
      duplicadosEntrePaginas: 0,
      origem: 'SGA',
    });
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      },
    ]);
    (service as any).expo.sendPushNotificationsAsync = jest.fn(() =>
      Promise.resolve([
        {
          status: 'error',
          message: 'device gone',
          details: { error: 'DeviceNotRegistered' },
        },
      ]),
    );

    const [resultado] = await service.executarRotina({
      dataReferencia: new Date(2026, 2, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(resultado.metricas).toMatchObject({
      totalEnviados: 0,
      totalFalhas: 1,
      totalTokensInvalidos: 1,
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 1,
        expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      },
      data: { expoPushToken: null },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('erro no SGA marca a execução como FALHA sem interromper os demais momentos', async () => {
    sgaClient.listarAbertosPorVencimentoOriginal
      .mockRejectedValueOnce(new Error('SGA fora do ar'))
      .mockResolvedValue({
        boletos: [],
        totalRegistros: 0,
        numeroPaginas: 0,
        paginasConsultadas: 1,
        duplicadosEntrePaginas: 0,
        origem: 'SGA',
      });

    const resultados = await service.executarRotina({
      dataReferencia: new Date(2026, 2, 10), // D0=10 (gatilho), D5=05 (gatilho), D6=04 (não)
      tenants: ['MAIS_PRIME'],
    });

    expect(resultados.map((r) => r.status)).toEqual([
      'FALHA',
      'CONCLUIDA',
      'PULADA',
    ]);
    expect(resultados[0].erro).toBe('SGA fora do ar');
    expect(prisma.boletoNotificacaoExecucao.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FALHA',
          erro: 'SGA fora do ar',
        }),
      }),
    );
  });
});

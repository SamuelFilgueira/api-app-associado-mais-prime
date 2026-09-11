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
    nomeAssociado: 'KAIO DA SILVA',
    cpf: '52998224725',
    dataVencimento: '2026-09-10',
    dataVencimentoOriginal: '2026-09-10',
    codigoSituacaoBoleto: '2',
    codigoTipoBoleto: '1',
    tipoBoleto: 'MENSALIDADE',
    situacaoBoleto: 'ABERTO',
    valorBoleto: '99.90',
    mesReferente: '09/2026',
    veiculos: [{ codigo_veiculo: 1, placa: 'ABC1D23' }],
    ...overrides,
  };
}

function consultaSga(boletos: unknown[], origem: 'SGA' | 'MOCK' = 'SGA') {
  return {
    boletos,
    totalRegistros: boletos.length,
    numeroPaginas: 1,
    paginasConsultadas: 1,
    duplicadosEntrePaginas: 0,
    origem,
  };
}

const TOKEN_VALIDO = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

describe('BoletoNotificacaoService (régua v2)', () => {
  let env: NodeJS.ProcessEnv;
  const config = { get: () => loadBoletoNotificacaoConfig(env) };
  const sgaClient = { listarAbertosPorVencimento: jest.fn() };
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
    env = {};
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
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(consultaSga([]));

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

  it('consulta todas as etapas todos os dias, com as janelas corretas de vencimento efetivo', async () => {
    const resultados = await service.executarRotina({
      dataReferencia: new Date(2026, 8, 10), // 10/09/2026
      tenants: ['MAIS_PRIME'],
      dryRun: true,
    });

    expect(resultados.map((r) => [r.tipo, r.dataAlvo])).toEqual([
      ['DM5', '11/09/2026 a 15/09/2026'],
      ['D0', '10/09/2026'],
      ['D1', '06/09/2026 a 09/09/2026'], // faixa de atraso 1..4
      ['D5', '05/09/2026'],
      ['D6', '22/08/2026 a 04/09/2026'], // faixa de atraso 6..19
      ['D20', '12/07/2026 a 21/08/2026'], // faixa de atraso 20..60
    ]);
    // Consulta ÚNICA por tenant: janela ampla D+60 (passado) até D-5 (futuro)
    expect(sgaClient.listarAbertosPorVencimento).toHaveBeenCalledTimes(1);
    expect(sgaClient.listarAbertosPorVencimento).toHaveBeenCalledWith(
      'MAIS_PRIME',
      new Date(2026, 6, 12), // hoje − 60 (D+20 + alcance 40)
      new Date(2026, 8, 15), // hoje + 5 (janela DM5)
    );
  });

  it('D0 renderiza a mensagem oficial da régua com {nome} e {placa}', async () => {
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: TOKEN_VALIDO,
      },
    ]);

    await service.executarRotina({
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    const logCriado = prisma.boletoNotificacaoLog.create.mock.calls[0][0].data;
    expect(logCriado.mensagemTitulo).toBe('Seu boleto vence hoje');
    expect(logCriado.mensagemEnviada).toBe(
      'Kaio, o boleto da proteção do ABC1D23 vence hoje. Pague em poucos toques pelo app e siga tranquilo.',
    );
    expect(logCriado.tipoMensagem).toBe('D0');
    expect(logCriado.dataVencimentoOriginal.toISOString()).toBe(
      '2026-09-10T00:00:00.000Z',
    );

    const enviados = (service as any).expo.sendPushNotificationsAsync.mock
      .calls[0][0];
    expect(enviados[0].data).toMatchObject({
      type: 'internal_route',
      screen: 'financeiro',
      tipoMensagem: 'D0',
      dataVencimentoOriginal: '2026-09-10',
    });
  });

  it('DM5 renderiza {mes} e {data} do vencimento do próprio boleto dentro da janela', async () => {
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([
        boletoSga({ dataVencimento: '2026-09-15', mesReferente: '09/2026' }),
      ]),
    );
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: TOKEN_VALIDO,
      },
    ]);

    const [resultado] = await service.executarRotina({
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['DM5'],
      dryRun: true,
    });

    expect(resultado.metricas.totalEnfileirados).toBe(1);
    expect(resultado.amostraDestinatarios?.[0]).toMatchObject({
      vencimento: '15/09/2026',
      titulo: 'Seu boleto de Setembro já está no app',
    });
    expect(resultado.amostraDestinatarios?.[0].corpo).toBe(
      'Oi, Kaio! O boleto da sua proteção já está disponível e vence em 15/09. Quando quiser, é só abrir o app e pagar.',
    );
  });

  it('agrupa por associado × vencimento, aplica idempotência, tenant e token', async () => {
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([
        boletoSga({ nossoNumero: '1', codigoAssociado: 55 }),
        boletoSga({ nossoNumero: '2', codigoAssociado: 55 }), // mesmo associado/vencimento → agrega
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
          codigoSituacaoBoleto: '1',
        }), // pago → fora
      ]),
    );
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: TOKEN_VALIDO,
      },
      {
        id: 2,
        cpf: '11144477735',
        baseOrigin: null,
        expoPushToken: TOKEN_VALIDO,
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
        expoPushToken: TOKEN_VALIDO,
      },
    ]);
    prisma.boletoNotificacaoLog.findMany.mockResolvedValue([
      {
        codigoAssociado: 77,
        dataVencimentoOriginal: new Date('2026-09-10T00:00:00.000Z'),
      },
    ]);

    const [resultado] = await service.executarRotina({
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(resultado.status).toBe('CONCLUIDA');
    expect(resultado.metricas).toMatchObject({
      totalBoletosElegiveis: 6,
      totalAssociados: 5,
      totalIdempotentes: 1,
      totalSemUsuario: 2,
      totalSemToken: 1,
      totalEnfileirados: 1,
      totalEnviados: 1,
      coberturaElegiveis: 0.2,
    });
    const logCriado = prisma.boletoNotificacaoLog.create.mock.calls[0][0].data;
    expect(logCriado).toMatchObject({
      codigoAssociado: 55,
      quantidadeBoletos: 2,
      statusEnvio: 'ENFILEIRADO',
    });
  });

  it('filtra por código de tipo de boleto quando configurado', async () => {
    env = { BOLETO_NOTIFICACAO_CODIGOS_TIPO_BOLETO: '1,5' };
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([
        boletoSga({ nossoNumero: '1', codigoTipoBoleto: '1' }),
        boletoSga({
          nossoNumero: '2',
          codigoAssociado: 66,
          cpf: '01234567890',
          codigoTipoBoleto: '27',
        }), // quitação → fora
      ]),
    );

    const [resultado] = await service.executarRotina({
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
      dryRun: true,
    });

    expect(resultado.metricas.totalBoletosElegiveis).toBe(1);
  });

  it('D6/D20 aplicam o filtro de contrato suspenso quando configurado; demais etapas não', async () => {
    env = { BOLETO_NOTIFICACAO_SITUACOES_SUSPENSO: 'INADIMPLENTE,INATIVO' };
    const boletos = [
      boletoSga({
        veiculos: [{ placa: 'AAA0A00', situacao_veiculo: 'ATIVO' }],
      }),
      boletoSga({
        codigoAssociado: 66,
        cpf: '01234567890',
        dataVencimento: '2026-09-04',
        veiculos: [{ placa: 'BBB0B00', situacao_veiculo: 'INADIMPLENTE' }],
      }),
    ];
    sgaClient.listarAbertosPorVencimento.mockImplementation(
      (_t: string, inicio: Date, fim: Date) =>
        Promise.resolve(
          consultaSga(
            boletos.filter((b) => {
              const venc = new Date(`${b.dataVencimento}T00:00:00`);
              return venc >= inicio && venc <= fim;
            }),
          ),
        ),
    );

    const resultados = await service.executarRotina({
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0', 'D6'],
      dryRun: true,
    });

    const d0 = resultados.find((r) => r.tipo === 'D0');
    const d6 = resultados.find((r) => r.tipo === 'D6');
    expect(d0?.metricas.totalBoletosElegiveis).toBe(1); // ATIVO passa no D0
    expect(d6?.metricas.totalBoletosElegiveis).toBe(1); // só o INADIMPLENTE passa no D6
  });

  it('dry-run não grava nem envia', async () => {
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()], 'MOCK'),
    );
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: TOKEN_VALIDO,
      },
    ]);

    const [resultado] = await service.executarRotina({
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
      dryRun: true,
    });

    expect(resultado.status).toBe('DRY_RUN');
    expect(resultado.origemDados).toBe('MOCK');
    expect(prisma.boletoNotificacaoExecucao.create).not.toHaveBeenCalled();
    expect(prisma.boletoNotificacaoLog.create).not.toHaveBeenCalled();
    expect(
      (service as any).expo.sendPushNotificationsAsync,
    ).not.toHaveBeenCalled();
  });

  it('ticket DeviceNotRegistered marca FALHA e invalida o token do usuário', async () => {
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );
    prisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        cpf: '52998224725',
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: TOKEN_VALIDO,
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
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(resultado.metricas).toMatchObject({
      totalEnviados: 0,
      totalFalhas: 1,
      totalTokensInvalidos: 1,
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 1, expoPushToken: TOKEN_VALIDO },
      data: { expoPushToken: null },
    });
  });

  it('erro na consulta do tenant marca TODAS as etapas do tenant como FALHA, sem afetar o outro tenant', async () => {
    sgaClient.listarAbertosPorVencimento
      .mockRejectedValueOnce(new Error('SGA fora do ar'))
      .mockResolvedValue(consultaSga([]));

    const resultados = await service.executarRotina({
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
      tipos: ['DM5', 'D0'],
    });

    expect(resultados.map((r) => [r.tenant, r.status])).toEqual([
      ['MAIS_PRIME', 'FALHA'],
      ['MAIS_PRIME', 'FALHA'],
      ['MAIS_PRIME_RS', 'CONCLUIDA'],
      ['MAIS_PRIME_RS', 'CONCLUIDA'],
    ]);
    expect(resultados[0].erro).toBe('SGA fora do ar');
  });
});

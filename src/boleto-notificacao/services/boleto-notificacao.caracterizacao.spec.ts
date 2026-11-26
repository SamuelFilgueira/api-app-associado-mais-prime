/**
 * Caracterização da régua ANTES da extração do god service: o que a rotina
 * devolve e o ESTADO que ela deixa no banco (execuções, logs, histórico).
 * Os asserts olham o estado final num Prisma em memória — não a chamada que
 * o produziu —, então valem igual depois da extração.
 */
import { Logger } from '@nestjs/common';
import {
  boletoSga,
  consultaSga,
  montarRegua,
} from 'src/boleto-notificacao/testing/montar-regua';

jest.mock('src/config/tenant.config', () => ({
  TENANT: {
    baseNames: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
    defaultBase: 'MAIS_PRIME',
  },
  isTenantBase: (v: unknown) => v === 'MAIS_PRIME' || v === 'MAIS_PRIME_RS',
}));

const DIA_10 = new Date(2026, 8, 10);
const cpfDe = (i: number) => String(10_000_000_000 + i);

describe('Régua de boletos — caracterização (estado final)', () => {
  beforeEach(() => {
    for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('simularDatas devolve a janela de cada etapa, sempre com gatilho', () => {
    const { service } = montarRegua();

    expect(service.simularDatas(new Date(2026, 8, 10, 15, 30))).toEqual([
      {
        tipo: 'DM5',
        offset: 5,
        dataAlvo: '11/09/2026 a 15/09/2026',
        gatilho: true,
      },
      { tipo: 'D0', offset: 0, dataAlvo: '10/09/2026', gatilho: true },
      {
        tipo: 'D1',
        offset: 1,
        dataAlvo: '06/09/2026 a 09/09/2026',
        gatilho: true,
      },
      { tipo: 'D5', offset: 5, dataAlvo: '05/09/2026', gatilho: true },
      {
        tipo: 'D6',
        offset: 6,
        dataAlvo: '22/08/2026 a 04/09/2026',
        gatilho: true,
      },
      {
        tipo: 'D20',
        offset: 20,
        dataAlvo: '12/07/2026 a 21/08/2026',
        gatilho: true,
      },
    ]);
  });

  it('execução real: abre a execução com a data-alvo no fim da janela, envia, grava ticket, histórico e conclui com as métricas', async () => {
    const { service, prisma, sgaClient, produtor } = montarRegua();
    const usuario = prisma.comUsuario('52998224725');
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga({ dataVencimento: '2026-09-08' })]),
    );

    const [resultado] = await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D1'],
      origem: 'AGENDADA',
    });

    expect(resultado).toMatchObject({
      tenant: 'MAIS_PRIME',
      tipo: 'D1',
      dataReferencia: '10/09/2026',
      dataAlvo: '06/09/2026 a 09/09/2026',
      gatilho: true,
      dryRun: false,
      status: 'CONCLUIDA',
      origemDados: 'SGA',
    });

    expect(prisma.execucoes).toHaveLength(1);
    const execucao = prisma.execucoes[0];
    expect(resultado.execucaoId).toBe(execucao.id);
    expect(execucao).toMatchObject({
      tenant: 'MAIS_PRIME',
      tipoMensagem: 'D1',
      status: 'CONCLUIDA',
      origem: 'AGENDADA',
      dryRun: false,
      totalRegistrosSga: 1,
      totalPaginasSga: 1,
      totalBoletosElegiveis: 1,
      totalAssociados: 1,
      totalEnfileirados: 1,
      totalEnviados: 1,
      totalFalhas: 0,
      coberturaElegiveis: 1,
    });
    expect(execucao.dataReferencia.toISOString()).toBe(
      '2026-09-10T00:00:00.000Z',
    );
    // fim da janela do D+1 (atraso 1) = véspera da referência
    expect(execucao.dataAlvo.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    expect(execucao.finalizadoEm).toBeInstanceOf(Date);

    expect(prisma.logs).toHaveLength(1);
    expect(prisma.logs[0]).toMatchObject({
      execucaoId: execucao.id,
      tenant: 'MAIS_PRIME',
      codigoAssociado: 55,
      cpf: '52998224725',
      userId: usuario.id,
      nossoNumero: '1001',
      quantidadeBoletos: 1,
      tipoMensagem: 'D1',
      expoPushToken: usuario.expoPushToken,
      statusEnvio: 'ENVIADO',
      expoTicketId: `ticket:${usuario.expoPushToken}`,
      mensagemTitulo: 'Lembrete rápido sobre seu boleto',
    });
    expect(prisma.logs[0].dataVencimentoOriginal.toISOString()).toBe(
      '2026-09-08T00:00:00.000Z',
    );

    // Histórico do sino: só o que foi enviado, com o deep-link do financeiro.
    expect(prisma.notificacoes).toHaveLength(1);
    expect(prisma.notificacoes[0]).toMatchObject({
      userId: usuario.id,
      expoPushToken: usuario.expoPushToken,
      title: 'Lembrete rápido sobre seu boleto',
      body: prisma.logs[0].mensagemEnviada,
      data: {
        type: 'internal_route',
        screen: 'financeiro',
        origem: 'boleto_cobranca',
        tipoMensagem: 'D1',
        dataVencimentoOriginal: '2026-09-08',
        quantidadeBoletos: 1,
      },
    });
    expect(prisma.notificacoes[0].sentAt).toBeInstanceOf(Date);

    // Recibos: um job por execução que enviou, com a base do tenant.
    expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
    expect(produtor.enfileirar.mock.calls[0].slice(0, 3)).toEqual([
      'boleto-notificacao',
      'verificar-receipts',
      { execucaoId: execucao.id, tentativa: 1 },
    ]);
  });

  it('push enviado ao Expo: som, prioridade, canal e flags de iOS', async () => {
    const { service, prisma, sgaClient, expo } = montarRegua();
    const usuario = prisma.comUsuario('52998224725');
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );

    await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(expo.sendPushNotificationsAsync.mock.calls[0][0]).toEqual([
      {
        to: usuario.expoPushToken,
        title: 'Seu boleto vence hoje',
        body: 'Kaio, o boleto da proteção do ABC1D23 vence hoje. Pague em poucos toques pelo app e siga tranquilo.',
        data: {
          type: 'internal_route',
          screen: 'financeiro',
          origem: 'boleto_cobranca',
          tipoMensagem: 'D0',
          dataVencimentoOriginal: '2026-09-10',
          quantidadeBoletos: 1,
        },
        sound: 'default',
        priority: 'high',
        channelId: 'alerts_v2',
        _contentAvailable: true,
        mutableContent: true,
      },
    ]);
  });

  it('sem nenhum envio (ninguém com app): conclui e não agenda verificação de recibos', async () => {
    const { service, prisma, sgaClient, produtor } = montarRegua();
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );

    const [resultado] = await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(resultado.status).toBe('CONCLUIDA');
    expect(resultado.metricas).toMatchObject({
      totalAssociados: 1,
      totalSemUsuario: 1,
      totalEnfileirados: 0,
      coberturaElegiveis: 0,
    });
    expect(prisma.logs).toEqual([]);
    expect(prisma.execucoes[0].status).toBe('CONCLUIDA');
    expect(produtor.enfileirar).not.toHaveBeenCalled();
  });

  it('falha na consulta ao SGA: grava uma execução FALHA por etapa, com o erro; em dry-run não grava', async () => {
    const { service, prisma, sgaClient } = montarRegua();
    sgaClient.listarAbertosPorVencimento.mockRejectedValue(
      new Error('SGA fora do ar'),
    );

    const resultados = await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D0', 'D5'],
      origem: 'AGENDADA',
    });

    expect(resultados.map((r) => [r.tipo, r.status, r.erro])).toEqual([
      ['D0', 'FALHA', 'SGA fora do ar'],
      ['D5', 'FALHA', 'SGA fora do ar'],
    ]);
    expect(
      prisma.execucoes.map((e) => [e.tipoMensagem, e.status, e.erro]),
    ).toEqual([
      ['D0', 'FALHA', 'SGA fora do ar'],
      ['D5', 'FALHA', 'SGA fora do ar'],
    ]);
    expect(prisma.execucoes[1].dataAlvo.toISOString()).toBe(
      '2026-09-05T00:00:00.000Z',
    );
    expect(prisma.execucoes[0].finalizadoEm).toBeInstanceOf(Date);
    expect(resultados.map((r) => r.execucaoId)).toEqual(
      prisma.execucoes.map((e) => e.id),
    );

    const simulados = await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
      dryRun: true,
    });
    expect(simulados[0]).toMatchObject({ status: 'FALHA', execucaoId: null });
    expect(prisma.execucoes).toHaveLength(2);
  });

  it('erro dentro de uma etapa: a execução dela vira FALHA com o erro e as outras etapas seguem', async () => {
    const { service, prisma, sgaClient } = montarRegua();
    prisma.comUsuario('52998224725');
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([
        boletoSga(), // D0
        boletoSga({
          nossoNumero: '2',
          dataVencimento: '2026-09-05',
          veiculos: [{ codigo_veiculo: 2, placa: 'XYZ9Z99' }],
        }), // D5 (outra placa: não é anulado pelo boleto mais recente)
      ]),
    );
    jest
      .spyOn(prisma.user, 'findMany')
      .mockRejectedValueOnce(new Error('banco fora'));

    const resultados = await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D0', 'D5'],
    });

    expect(resultados.map((r) => [r.tipo, r.status, r.erro])).toEqual([
      ['D0', 'FALHA', 'banco fora'],
      ['D5', 'CONCLUIDA', undefined],
    ]);
    expect(prisma.execucoes.map((e) => [e.status, e.erro])).toEqual([
      ['FALHA', 'banco fora'],
      ['CONCLUIDA', null],
    ]);
    expect(prisma.execucoes[0].finalizadoEm).toBeInstanceOf(Date);
    expect(prisma.logs.map((l) => [l.tipoMensagem, l.statusEnvio])).toEqual([
      ['D5', 'ENVIADO'],
    ]);
  });

  it('ticket recusado pelo Expo (não é token morto): log FALHA com o motivo e o token do usuário fica', async () => {
    const { service, prisma, sgaClient, expo } = montarRegua();
    const comDetalhe = prisma.comUsuario('52998224725');
    const semDetalhe = prisma.comUsuario('11144477735');
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([
        boletoSga(),
        boletoSga({
          nossoNumero: '2',
          codigoAssociado: 66,
          cpf: '11144477735',
        }),
      ]),
    );
    expo.sendPushNotificationsAsync.mockResolvedValue([
      {
        status: 'error',
        message: 'payload grande',
        details: { error: 'MessageTooBig' },
      },
      { status: 'error', message: 'recusado' },
    ] as never);

    const [resultado] = await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(resultado.status).toBe('CONCLUIDA');
    expect(resultado.metricas).toMatchObject({
      totalEnfileirados: 2,
      totalEnviados: 0,
      totalFalhas: 2,
      totalTokensInvalidos: 0,
    });
    expect(prisma.logs.map((l) => [l.statusEnvio, l.expoErro])).toEqual([
      ['FALHA', 'MessageTooBig: payload grande'],
      ['FALHA', 'TICKET_ERROR: recusado'],
    ]);
    expect(prisma.usuarios.map((u) => u.expoPushToken)).toEqual([
      comDetalhe.expoPushToken,
      semDetalhe.expoPushToken,
    ]);
    expect(prisma.notificacoes).toEqual([]);
  });

  it('corrida na unique de idempotência (outra execução gravou primeiro): conta como idempotente e não envia', async () => {
    const { service, prisma, sgaClient, expo } = montarRegua();
    const usuario = prisma.comUsuario('52998224725');
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );
    // A outra execução já enviou; esta leu os logs um instante antes.
    await prisma.boletoNotificacaoLog.create({
      data: {
        execucaoId: 999,
        tenant: 'MAIS_PRIME',
        codigoAssociado: 55,
        cpf: '52998224725',
        userId: usuario.id,
        dataVencimentoOriginal: new Date('2026-09-10T00:00:00.000Z'),
        tipoMensagem: 'D0',
        statusEnvio: 'ENVIADO',
        expoTicketId: 'ticket-da-outra',
      },
    });
    jest
      .spyOn(prisma.boletoNotificacaoLog, 'findMany')
      .mockResolvedValueOnce([]);

    const [resultado] = await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(resultado.status).toBe('CONCLUIDA');
    expect(resultado.metricas).toMatchObject({
      totalIdempotentes: 1,
      totalEnfileirados: 0,
      totalEnviados: 0,
    });
    expect(expo.sendPushNotificationsAsync).not.toHaveBeenCalled();
    expect(prisma.logs).toHaveLength(1);
    expect(prisma.logs[0].expoTicketId).toBe('ticket-da-outra');
  });

  it('250 destinatários em 3 lotes, o do meio sem resposta do Expo: cada log fica com o ticket do PRÓPRIO push e o lote do meio vira falha de transporte', async () => {
    const { service, prisma, sgaClient, expo, produtor } = montarRegua();
    const usuarios = Array.from({ length: 250 }, (_, i) =>
      prisma.comUsuario(cpfDe(i)),
    );
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga(
        usuarios.map((_, i) =>
          boletoSga({
            nossoNumero: String(5000 + i),
            codigoAssociado: 1000 + i,
            cpf: cpfDe(i),
            veiculos: [{ codigo_veiculo: i, placa: `PLC${i}` }],
          }),
        ),
      ),
    );
    const tokensDoMeio = new Set(
      usuarios.slice(100, 200).map((u) => u.expoPushToken),
    );
    expo.sendPushNotificationsAsync.mockImplementation(
      (mensagens: Array<{ to: string }>) =>
        mensagens.some((m) => tokensDoMeio.has(m.to))
          ? Promise.reject(new Error('socket hang up'))
          : Promise.resolve(
              mensagens.map((m) => ({ status: 'ok', id: `ticket:${m.to}` })),
            ),
    );

    const [resultado] = await service.executarRotina({
      dataReferencia: DIA_10,
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
    });

    expect(resultado.status).toBe('CONCLUIDA');
    expect(resultado.metricas).toMatchObject({
      totalAssociados: 250,
      totalEnfileirados: 250,
      totalEnviados: 150,
      totalFalhas: 100,
      totalTokensInvalidos: 0,
    });

    expect(prisma.logs).toHaveLength(250);
    for (const log of prisma.logs) {
      const indice = (log.codigoAssociado as number) - 1000;
      const usuario = usuarios[indice];
      expect(log.userId).toBe(usuario.id);
      expect(log.expoPushToken).toBe(usuario.expoPushToken);
      if (indice >= 100 && indice < 200) {
        expect(log.statusEnvio).toBe('FALHA');
        expect(log.expoTicketId).toBeNull();
        expect(log.expoErro).toBe('SEND_ERROR: socket hang up');
      } else {
        expect(log.statusEnvio).toBe('ENVIADO');
        expect(log.expoTicketId).toBe(`ticket:${usuario.expoPushToken}`);
        expect(log.expoErro).toBeNull();
      }
    }

    // Histórico só para quem recebeu, cada um com o próprio token.
    expect(prisma.notificacoes).toHaveLength(150);
    expect(
      prisma.notificacoes.every(
        (n) => !tokensDoMeio.has(n.expoPushToken as string),
      ),
    ).toBe(true);
    expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
  });
});

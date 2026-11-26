/**
 * "Quem caiu no meio nunca recebe": o que acontece com um log cujo envio não
 * se completou (órfão ENFILEIRADO, falha de transporte) e a correspondência
 * ticket ↔ log quando um lote fica sem resposta do Expo. Régua inteira, com
 * repositórios reais sobre o Prisma em memória.
 */
import { Logger } from '@nestjs/common';
import { avaliarRegua } from 'src/boleto-notificacao/domain/regua-resultado';
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
const VENCIMENTO = new Date('2026-09-10T00:00:00.000Z');
const D0 = {
  dataReferencia: DIA_10,
  tenants: ['MAIS_PRIME'],
  tipos: ['D0' as const],
};
const haMinutos = (min: number) => new Date(Date.now() - min * 60_000);
const cpfDe = (i: number) => String(10_000_000_000 + i);

describe('Régua — reenvio do que não se completou e correspondência ticket ↔ log', () => {
  beforeEach(() => {
    for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  /** Um associado com boleto vencendo hoje e um log já gravado para ele. */
  async function comLogAnterior(
    campos: Record<string, unknown>,
    atualizadoEm: Date = haMinutos(30),
  ) {
    const montagem = montarRegua();
    const { prisma, sgaClient } = montagem;
    const usuario = prisma.comUsuario('52998224725');
    sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );
    const log = await prisma.boletoNotificacaoLog.create({
      data: {
        execucaoId: 900, // execução anterior (a que caiu)
        tenant: 'MAIS_PRIME',
        codigoAssociado: 55,
        cpf: '52998224725',
        userId: usuario.id,
        dataVencimentoOriginal: VENCIMENTO,
        tipoMensagem: 'D0',
        expoPushToken: 'ExponentPushToken[token-antigo]',
        mensagemTitulo: 'título antigo',
        mensagemEnviada: 'corpo antigo',
        ...campos,
      },
    });
    prisma.logs[0].atualizadoEm = atualizadoEm;
    return { ...montagem, usuario, logId: log.id as number };
  }

  describe('na seleção', () => {
    it('ENFILEIRADO órfão (sem ticket, antigo): é reenviado na mesma linha, agora desta execução', async () => {
      const { service, prisma, expo, usuario, logId } = await comLogAnterior({
        statusEnvio: 'ENFILEIRADO',
      });

      const [resultado] = await service.executarRotina(D0);

      expect(resultado.status).toBe('CONCLUIDA');
      expect(resultado.metricas).toMatchObject({
        totalIdempotentes: 0,
        totalEnfileirados: 1,
        totalReenvios: 1,
        totalEnviados: 1,
        totalPendentes: 0,
      });
      expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
      // Não nasce linha nova: a unique de idempotência continua valendo.
      expect(prisma.logs).toHaveLength(1);
      expect(prisma.logs[0]).toMatchObject({
        id: logId,
        execucaoId: resultado.execucaoId,
        statusEnvio: 'ENVIADO',
        expoTicketId: `ticket:${usuario.expoPushToken}`,
        expoErro: null,
        // token e textos são os de AGORA, não os da execução que caiu
        expoPushToken: usuario.expoPushToken,
        mensagemTitulo: 'Seu boleto vence hoje',
      });
      expect(avaliarRegua([resultado]).incompleta).toBe(false);
    });

    it('FALHA de transporte (SEND_ERROR) de outra execução: é reenviada', async () => {
      const { service, prisma, usuario } = await comLogAnterior(
        { statusEnvio: 'FALHA', expoErro: 'SEND_ERROR: socket hang up' },
        haMinutos(0),
      );

      const [resultado] = await service.executarRotina(D0);

      expect(resultado.metricas).toMatchObject({
        totalReenvios: 1,
        totalEnviados: 1,
      });
      expect(prisma.logs[0]).toMatchObject({
        statusEnvio: 'ENVIADO',
        expoTicketId: `ticket:${usuario.expoPushToken}`,
        expoErro: null,
      });
    });

    it.each([
      ['ENVIADO', { statusEnvio: 'ENVIADO', expoTicketId: 't-antigo' }],
      ['ENTREGUE', { statusEnvio: 'ENTREGUE', expoTicketId: 't-antigo' }],
      [
        'FALHA por token inválido',
        { statusEnvio: 'FALHA', expoErro: 'DeviceNotRegistered: sem o app' },
      ],
      [
        'FALHA por recusa do Expo',
        { statusEnvio: 'FALHA', expoErro: 'TICKET_ERROR: recusado' },
      ],
      [
        'FALHA no recibo',
        {
          statusEnvio: 'FALHA',
          expoTicketId: 't-antigo',
          expoErro: 'RECEIPT_ERROR: recusado',
        },
      ],
    ])('%s: NÃO reenvia e a linha fica como estava', async (_nome, campos) => {
      const { service, prisma, expo } = await comLogAnterior(campos);
      const antes = { ...prisma.logs[0] };

      const [resultado] = await service.executarRotina(D0);

      expect(resultado.status).toBe('CONCLUIDA');
      expect(resultado.metricas).toMatchObject({
        totalIdempotentes: 1,
        totalEnfileirados: 0,
        totalReenvios: 0,
        totalEnviados: 0,
        totalPendentes: 0,
      });
      expect(expo.sendPushNotificationsAsync).not.toHaveBeenCalled();
      expect(prisma.logs).toEqual([antes]);
    });

    it('ENFILEIRADO recente (pode ser de uma execução viva): não envia, fica pendente e a régua sai incompleta', async () => {
      const { service, prisma, expo } = await comLogAnterior(
        { statusEnvio: 'ENFILEIRADO' },
        haMinutos(1),
      );

      const [resultado] = await service.executarRotina(D0);

      expect(resultado.status).toBe('CONCLUIDA');
      expect(resultado.metricas).toMatchObject({
        totalIdempotentes: 1,
        totalEnviados: 0,
        totalPendentes: 1,
      });
      expect(expo.sendPushNotificationsAsync).not.toHaveBeenCalled();
      expect(prisma.logs[0]).toMatchObject({
        execucaoId: 900,
        statusEnvio: 'ENFILEIRADO',
      });
      // O job lança e a fila repete; no retry (≥ 10 min) a linha já é órfã.
      expect(avaliarRegua([resultado]).basesComPendencia).toEqual([
        { base: 'MAIS_PRIME', pendentes: 1 },
      ]);
    });

    it('dry-run mostra o órfão como destinatário, sem tocar no log', async () => {
      const { service, prisma } = await comLogAnterior({
        statusEnvio: 'ENFILEIRADO',
      });
      const antes = { ...prisma.logs[0] };

      const [resultado] = await service.executarRotina({ ...D0, dryRun: true });

      expect(resultado.status).toBe('DRY_RUN');
      expect(resultado.amostraDestinatarios).toHaveLength(1);
      expect(prisma.logs).toEqual([antes]);
    });

    it('outra execução assumiu o órfão entre a leitura e a retomada: esta não envia', async () => {
      const { service, prisma, expo } = await comLogAnterior({
        statusEnvio: 'ENFILEIRADO',
      });
      const lidoAntes = { ...prisma.logs[0] };
      // A leitura devolve o retrato antigo; no banco a linha já foi tocada.
      jest
        .spyOn(prisma.boletoNotificacaoLog, 'findMany')
        .mockResolvedValueOnce([lidoAntes]);
      prisma.logs[0].execucaoId = 901;
      prisma.logs[0].atualizadoEm = new Date();

      const [resultado] = await service.executarRotina(D0);

      expect(resultado.metricas).toMatchObject({
        totalIdempotentes: 1,
        totalEnfileirados: 0,
        totalReenvios: 0,
        totalEnviados: 0,
      });
      expect(expo.sendPushNotificationsAsync).not.toHaveBeenCalled();
      expect(prisma.logs[0].execucaoId).toBe(901);
    });
  });

  describe('falha de transporte dentro da execução', () => {
    it('lote sem resposta do Expo ganha uma segunda rodada na mesma execução e é enviado', async () => {
      const { service, prisma, sgaClient, expo } = montarRegua();
      const usuario = prisma.comUsuario('52998224725');
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(
        consultaSga([boletoSga()]),
      );
      expo.sendPushNotificationsAsync.mockRejectedValueOnce(
        new Error('socket hang up'),
      );

      const [resultado] = await service.executarRotina(D0);

      expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(2);
      expect(resultado.metricas).toMatchObject({
        totalEnfileirados: 1,
        totalEnviados: 1,
        totalFalhas: 0,
        totalPendentes: 0,
      });
      expect(prisma.logs).toHaveLength(1);
      expect(prisma.logs[0]).toMatchObject({
        statusEnvio: 'ENVIADO',
        expoTicketId: `ticket:${usuario.expoPushToken}`,
        expoErro: null,
      });
      expect(prisma.notificacoes).toHaveLength(1);
    });

    it('Expo fora nas duas rodadas: o log fica FALHA de transporte, a etapa conclui com pendência e a reexecução entrega', async () => {
      const { service, prisma, sgaClient, expo, produtor } = montarRegua();
      const usuario = prisma.comUsuario('52998224725');
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(
        consultaSga([boletoSga()]),
      );
      expo.sendPushNotificationsAsync
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'));

      const [primeira] = await service.executarRotina(D0);

      expect(primeira.status).toBe('CONCLUIDA');
      expect(primeira.metricas).toMatchObject({
        totalEnviados: 0,
        totalFalhas: 1,
        totalPendentes: 1,
      });
      expect(prisma.logs[0]).toMatchObject({
        statusEnvio: 'FALHA',
        expoTicketId: null,
        expoErro: 'SEND_ERROR: timeout',
      });
      expect(avaliarRegua([primeira]).incompleta).toBe(true);
      expect(produtor.enfileirar).not.toHaveBeenCalled(); // nada a conferir

      const [segunda] = await service.executarRotina(D0); // retry da fila

      expect(segunda.metricas).toMatchObject({
        totalReenvios: 1,
        totalEnviados: 1,
        totalPendentes: 0,
      });
      expect(prisma.logs).toHaveLength(1);
      expect(prisma.logs[0]).toMatchObject({
        execucaoId: segunda.execucaoId,
        statusEnvio: 'ENVIADO',
        expoTicketId: `ticket:${usuario.expoPushToken}`,
      });
      expect(avaliarRegua([segunda]).incompleta).toBe(false);
      // Quem já recebeu não recebe de novo numa terceira passada.
      const [terceira] = await service.executarRotina(D0);
      expect(terceira.metricas).toMatchObject({
        totalIdempotentes: 1,
        totalEnviados: 0,
      });
      expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(3);
    });

    it('Expo devolve menos tickets que mensagens: quem ficou sem ticket vira falha de transporte, nunca herda o ticket do vizinho', async () => {
      const { service, prisma, sgaClient, expo } = montarRegua();
      const primeiro = prisma.comUsuario(cpfDe(1));
      prisma.comUsuario(cpfDe(2));
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(
        consultaSga([
          boletoSga({ codigoAssociado: 1, cpf: cpfDe(1) }),
          boletoSga({
            nossoNumero: '2',
            codigoAssociado: 2,
            cpf: cpfDe(2),
            veiculos: [{ placa: 'OUT0R00' }],
          }),
        ]),
      );
      expo.sendPushNotificationsAsync.mockImplementation(
        (mensagens: Array<{ to: string }>) =>
          Promise.resolve(
            mensagens.length > 1
              ? [{ status: 'ok', id: `ticket:${mensagens[0].to}` }]
              : [],
          ),
      );

      const [resultado] = await service.executarRotina(D0);

      expect(resultado.metricas).toMatchObject({
        totalEnviados: 1,
        totalFalhas: 1,
        totalPendentes: 1,
      });
      expect(
        prisma.logs.map((l) => [
          l.codigoAssociado,
          l.statusEnvio,
          l.expoTicketId,
        ]),
      ).toEqual([
        [1, 'ENVIADO', `ticket:${primeiro.expoPushToken}`],
        [2, 'FALHA', null],
      ]);
      expect(prisma.logs[1].expoErro).toBe(
        'SEND_ERROR: Expo não devolveu ticket',
      );
    });
  });

  describe('correspondência ticket ↔ log com 250 destinatários', () => {
    function com250() {
      const montagem = montarRegua();
      const { prisma, sgaClient } = montagem;
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
      return { ...montagem, usuarios };
    }

    it('lote do meio sem resposta na 1ª rodada: os lotes 1 e 3 seguem, o do meio é reenviado e os 250 logs ficam com o ticket do PRÓPRIO push', async () => {
      const { service, prisma, expo, usuarios, produtor } = com250();
      const tokensDoMeio = new Set(
        usuarios.slice(100, 200).map((u) => u.expoPushToken),
      );
      let falhou = false;
      expo.sendPushNotificationsAsync.mockImplementation(
        (mensagens: Array<{ to: string }>) => {
          if (!falhou && mensagens.some((m) => tokensDoMeio.has(m.to))) {
            falhou = true;
            return Promise.reject(new Error('socket hang up'));
          }
          // Ticket embaralhado de propósito: o que identifica é o token.
          return Promise.resolve(
            mensagens.map((m) => ({ status: 'ok', id: `ticket:${m.to}` })),
          );
        },
      );

      const [resultado] = await service.executarRotina(D0);

      // 100 + 100 (falha) + 50 + 100 (segunda rodada do lote do meio)
      expect(
        expo.sendPushNotificationsAsync.mock.calls.map((c) => c[0].length),
      ).toEqual([100, 100, 50, 100]);
      expect(resultado.metricas).toMatchObject({
        totalAssociados: 250,
        totalEnfileirados: 250,
        totalEnviados: 250,
        totalFalhas: 0,
        totalPendentes: 0,
      });

      expect(prisma.logs).toHaveLength(250);
      for (const log of prisma.logs) {
        const usuario = usuarios[(log.codigoAssociado as number) - 1000];
        expect(log).toMatchObject({
          userId: usuario.id,
          expoPushToken: usuario.expoPushToken,
          statusEnvio: 'ENVIADO',
          expoTicketId: `ticket:${usuario.expoPushToken}`,
          expoErro: null,
        });
      }
      // Tickets todos distintos: nenhum log ficou com o ticket de outro.
      expect(
        new Set(prisma.logs.map((l) => l.expoTicketId as string)).size,
      ).toBe(250);
      expect(prisma.notificacoes).toHaveLength(250);
      expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
    });

    it('recusas espalhadas pelos lotes: cada recusa cai no log do destinatário certo e só o token morto é apagado', async () => {
      const { service, prisma, expo, usuarios } = com250();
      const mortos = new Set(
        [usuarios[7], usuarios[150], usuarios[249]].map((u) => u.expoPushToken),
      );
      const grandes = new Set(
        [usuarios[99], usuarios[100]].map((u) => u.expoPushToken),
      );
      expo.sendPushNotificationsAsync.mockImplementation(
        (mensagens: Array<{ to: string }>) =>
          Promise.resolve(
            mensagens.map((m) =>
              mortos.has(m.to)
                ? {
                    status: 'error',
                    message: 'sem o app',
                    details: { error: 'DeviceNotRegistered' },
                  }
                : grandes.has(m.to)
                  ? {
                      status: 'error',
                      message: 'payload grande',
                      details: { error: 'MessageTooBig' },
                    }
                  : { status: 'ok', id: `ticket:${m.to}` },
            ),
          ),
      );

      const [resultado] = await service.executarRotina(D0);

      expect(resultado.metricas).toMatchObject({
        totalEnviados: 245,
        totalFalhas: 5,
        totalTokensInvalidos: 3,
        totalPendentes: 0,
      });
      const falhas = prisma.logs
        .filter((l) => l.statusEnvio === 'FALHA')
        .map((l) => [(l.codigoAssociado as number) - 1000, l.expoErro]);
      expect(falhas).toEqual([
        [7, 'DeviceNotRegistered: sem o app'],
        [99, 'MessageTooBig: payload grande'],
        [100, 'MessageTooBig: payload grande'],
        [150, 'DeviceNotRegistered: sem o app'],
        [249, 'DeviceNotRegistered: sem o app'],
      ]);
      expect(
        prisma.usuarios
          .map((u, i) => (u.expoPushToken === null ? i : -1))
          .filter((i) => i >= 0),
      ).toEqual([7, 150, 249]);
    });
  });
});

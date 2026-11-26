import { Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { EconomiaService } from 'src/economia/services/economia.service';
import { FuelSessionRepository } from 'src/fuel-session/repositories/fuel-session.repository';
import { VerificacaoDeEconomiaService } from 'src/fuel-session/services/verificacao-de-economia.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { FUEL_ECONOMY_QUEUE } from 'src/queue/queue.module';

describe('VerificacaoDeEconomiaService', () => {
  const sessoes = {
    buscarPorId: jest.fn(),
    concluir: jest.fn(),
    expirar: jest.fn(),
  };
  const economia = { consultarTotalEconomizado: jest.fn() };
  const notifications = { sendPushNotification: jest.fn() };
  const prisma = { user: { findUnique: jest.fn() } };
  const produtor = { enfileirar: jest.fn() };
  let service: VerificacaoDeEconomiaService;
  const logs = {} as Record<'log' | 'warn' | 'error', jest.SpyInstance>;

  const totalNoClubgas = (total: string) =>
    economia.consultarTotalEconomizado.mockResolvedValue({
      totalEconomizado: total,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const nivel of ['log', 'warn', 'error'] as const) {
      logs[nivel] = jest
        .spyOn(Logger.prototype, nivel)
        .mockImplementation(() => undefined);
    }
    sessoes.buscarPorId.mockResolvedValue({
      id: 'sessao-1',
      status: 'PENDING',
      userId: 42,
      valorAntes: 100,
    });
    sessoes.concluir.mockResolvedValue(true);
    sessoes.expirar.mockResolvedValue(true);
    prisma.user.findUnique.mockResolvedValue({
      expoPushToken: 'ExponentPushToken[x]',
    });
    notifications.sendPushNotification.mockResolvedValue({ success: true });
    produtor.enfileirar.mockResolvedValue({ id: 'job' });

    service = new VerificacaoDeEconomiaService(
      sessoes as unknown as FuelSessionRepository,
      economia as unknown as EconomiaService,
      notifications as unknown as NotificationsService,
      prisma as unknown as PrismaService,
      produtor as unknown as ProdutorDeFilas,
    );
  });

  afterAll(() => jest.restoreAllMocks());

  describe('abastecimento detectado', () => {
    beforeEach(() => totalNoClubgas('112.5'));

    it('conclui a sessão com a diferença e envia UM push', async () => {
      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).resolves.toEqual({
        processed: true,
        diferenca: 12.5,
        novoTotal: 112.5,
        push: 'enviado',
      });

      expect(economia.consultarTotalEconomizado).toHaveBeenCalledWith(
        42,
        'JOB_ECONOMIA',
      );
      expect(sessoes.concluir).toHaveBeenCalledWith({
        sessionId: 'sessao-1',
        userId: 42,
        valorDepois: 112.5,
        diferenca: 12.5,
      });
      expect(notifications.sendPushNotification).toHaveBeenCalledTimes(1);
      expect(notifications.sendPushNotification).toHaveBeenCalledWith(
        42,
        'ExponentPushToken[x]',
        'Abastecimento detectado! 🎉',
        'Parabéns! Você economizou R$ 12,50 neste abastecimento.',
        { type: 'fuel_economy', diferenca: 12.5, novoTotal: 112.5 },
      );
      expect(produtor.enfileirar).not.toHaveBeenCalled();
    });

    it('quem perde a corrida da conclusão não envia push', async () => {
      sessoes.concluir.mockResolvedValue(false);

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).resolves.toEqual({ skipped: true, reason: 'already_processed' });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });

    it('usuário sem token de push: conclui e o resultado diz que não houve push', async () => {
      prisma.user.findUnique.mockResolvedValue({ expoPushToken: null });

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).resolves.toMatchObject({ processed: true, push: 'sem_token' });
      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });

    it('Expo recusou o push: conclui e o resultado diz que falhou', async () => {
      notifications.sendPushNotification.mockResolvedValue({
        success: false,
        message: 'DeviceNotRegistered',
      });

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).resolves.toMatchObject({ processed: true, push: 'falhou' });
    });
  });

  describe('sem variação de saldo', () => {
    beforeEach(() => totalNoClubgas('100'));

    it('conclui normalmente (não lança) e reagenda a próxima checagem com atraso crescente', async () => {
      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).resolves.toEqual({
        processed: false,
        reason: 'sem_variacao',
        checagem: 1,
        proximaChecagem: 2,
        atrasoMs: 60_000,
      });

      expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
      expect(produtor.enfileirar).toHaveBeenCalledWith(
        FUEL_ECONOMY_QUEUE,
        'check-fuel-economy',
        { fuelSessionId: 'sessao-1', checagem: 2 },
        // Job sem base no payload (antigo): a próxima checagem segue sem ela.
        { base: null, atrasoMs: 60_000, jobId: 'fuel-sessao-1-c2' },
      );
      expect(sessoes.concluir).not.toHaveBeenCalled();
      expect(sessoes.expirar).not.toHaveBeenCalled();
      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });

    it('segunda checagem: a terceira fica para 120 s depois', async () => {
      await service.verificar({ fuelSessionId: 'sessao-1', checagem: 2 }, 0);

      expect(produtor.enfileirar).toHaveBeenCalledWith(
        FUEL_ECONOMY_QUEUE,
        'check-fuel-economy',
        { fuelSessionId: 'sessao-1', checagem: 3 },
        { base: null, atrasoMs: 120_000, jobId: 'fuel-sessao-1-c3' },
      );
    });

    it('a base do job segue para a próxima checagem', async () => {
      await service.verificar(
        {
          fuelSessionId: 'sessao-1',
          checagem: 1,
          baseOrigin: 'MAIS_PRIME',
        } as never,
        0,
      );

      expect(produtor.enfileirar.mock.calls[0][3]).toMatchObject({
        base: 'MAIS_PRIME',
      });
    });

    it('no teto de checagens: expira a sessão e não reagenda', async () => {
      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 3 }, 0),
      ).resolves.toEqual({
        processed: false,
        reason: 'teto_de_checagens',
        checagem: 3,
        expirada: true,
      });

      expect(sessoes.expirar).toHaveBeenCalledWith('sessao-1');
      expect(produtor.enfileirar).not.toHaveBeenCalled();
    });

    it('retry por erro de verdade não avança o contador de checagens', async () => {
      // Segunda tentativa do job da checagem 1.
      await service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 1);

      expect(produtor.enfileirar.mock.calls[0][2]).toEqual({
        fuelSessionId: 'sessao-1',
        checagem: 2,
      });
    });
  });

  describe('job antigo, enfileirado antes do contador (payload só com fuelSessionId)', () => {
    it('abastecimento detectado: conclui como sempre', async () => {
      totalNoClubgas('130');

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1' }, 0),
      ).resolves.toMatchObject({ processed: true, diferenca: 30 });
    });

    it('primeira execução sem variação: vira a checagem 1 e reagenda a 2', async () => {
      totalNoClubgas('100');

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1' }, 0),
      ).resolves.toMatchObject({ reason: 'sem_variacao', proximaChecagem: 2 });
      expect(produtor.enfileirar.mock.calls[0][3]).toMatchObject({
        atrasoMs: 60_000,
        jobId: 'fuel-sessao-1-c2',
      });
    });

    it('já tinha gasto duas tentativas no desenho antigo: esta é a terceira checagem e expira', async () => {
      totalNoClubgas('100');

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1' }, 2),
      ).resolves.toMatchObject({ reason: 'teto_de_checagens', expirada: true });
      expect(produtor.enfileirar).not.toHaveBeenCalled();
    });
  });

  describe('nada a fazer', () => {
    it('sessão inexistente: ignora sem consultar o Clubgas', async () => {
      sessoes.buscarPorId.mockResolvedValue(null);

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).resolves.toEqual({ skipped: true, reason: 'session_not_found' });
      expect(economia.consultarTotalEconomizado).not.toHaveBeenCalled();
    });

    it.each(['COMPLETED', 'EXPIRED'])(
      'sessão %s: entrega repetida não consulta o Clubgas nem repete efeito',
      async (status) => {
        sessoes.buscarPorId.mockResolvedValue({
          id: 'sessao-1',
          status,
          userId: 42,
          valorAntes: 100,
        });

        await expect(
          service.verificar({ fuelSessionId: 'sessao-1', checagem: 2 }, 0),
        ).resolves.toEqual({
          skipped: true,
          reason: 'already_processed',
          status,
        });
        expect(economia.consultarTotalEconomizado).not.toHaveBeenCalled();
      },
    );
  });

  describe('erro de verdade continua lançando (segue o retry da fila)', () => {
    it('Clubgas fora', async () => {
      const falha = new Error('502 Bad Gateway');
      economia.consultarTotalEconomizado.mockRejectedValue(falha);

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).rejects.toBe(falha);
      expect(sessoes.expirar).not.toHaveBeenCalled();
      expect(produtor.enfileirar).not.toHaveBeenCalled();
    });

    it('Clubgas devolveu `errors`', async () => {
      economia.consultarTotalEconomizado.mockResolvedValue({
        totalEconomizado: '100',
        errors: ['falha interna'],
      });

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).rejects.toThrow(/Erro na API externa de economia/);
    });

    it('total não numérico', async () => {
      totalNoClubgas('abc');

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).rejects.toThrow(/Valor inválido retornado pela API externa: "abc"/);
    });

    it('banco fora ao concluir', async () => {
      totalNoClubgas('112.5');
      sessoes.concluir.mockRejectedValue(new Error("Can't reach database"));

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).rejects.toThrow(/Can't reach database/);
      expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    });

    it('fila fora ao reagendar: o job falha e repete (a sessão continua pendente)', async () => {
      totalNoClubgas('100');
      produtor.enfileirar.mockRejectedValue(new Error('Connection is closed.'));

      await expect(
        service.verificar({ fuelSessionId: 'sessao-1', checagem: 1 }, 0),
      ).rejects.toThrow(/Connection is closed/);
      expect(sessoes.expirar).not.toHaveBeenCalled();
    });
  });

  describe('expirarAposFalhaDoJob — o job morreu', () => {
    it('expira a sessão', async () => {
      await expect(service.expirarAposFalhaDoJob('sessao-1')).resolves.toBe(
        'EXPIRADA',
      );
      expect(sessoes.expirar).toHaveBeenCalledTimes(1);
    });

    it('sessão que já não estava pendente', async () => {
      sessoes.expirar.mockResolvedValue(false);

      await expect(service.expirarAposFalhaDoJob('sessao-1')).resolves.toBe(
        'JA_ENCERRADA',
      );
    });

    it('falha ao expirar: tenta de novo e consegue', async () => {
      sessoes.expirar
        .mockRejectedValueOnce(new Error('deadlock'))
        .mockResolvedValueOnce(true);

      await expect(service.expirarAposFalhaDoJob('sessao-1')).resolves.toBe(
        'EXPIRADA',
      );
      expect(sessoes.expirar).toHaveBeenCalledTimes(2);
      expect(logs.error).not.toHaveBeenCalled();
    });

    it('todas as tentativas falham: não lança, o resultado diz FALHOU e o erro é registrado', async () => {
      sessoes.expirar.mockRejectedValue(new Error("Can't reach database"));

      await expect(service.expirarAposFalhaDoJob('sessao-1')).resolves.toBe(
        'FALHOU',
      );
      expect(sessoes.expirar).toHaveBeenCalledTimes(3);
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'vence por tempo na próxima abertura do cartão',
        ),
      );
    });
  });
});

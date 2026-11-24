import { BadRequestException, ConflictException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';

describe('MarketingAgendamentoService', () => {
  let log: {
    updateMany: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findMany: jest.Mock;
  };
  let audit: {
    createRequestAudit: jest.Mock;
    markSuccess: jest.Mock;
    markFailure: jest.Mock;
  };
  let notifications: { sendMarketingNotification: jest.Mock };
  let fila: { add: jest.Mock; getJob: jest.Mock; remove: jest.Mock };
  let service: MarketingAgendamentoService;

  const emMinutos = (min: number) =>
    new Date(Date.now() + min * 60_000).toISOString();

  beforeEach(() => {
    log = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 7, status: 'SCHEDULED' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        title: 'Título',
        body: 'Corpo',
        messagePayload: { type: 'external_link', url: 'https://x' },
        adminPanelUserId: 3,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    };
    audit = {
      createRequestAudit: jest.fn().mockResolvedValue(7),
      markSuccess: jest.fn(),
      markFailure: jest.fn(),
    };
    notifications = {
      sendMarketingNotification: jest
        .fn()
        .mockResolvedValue({ sentCount: 10, skippedCount: 2 }),
    };
    fila = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
      remove: jest.fn().mockResolvedValue(1),
    };
    service = new MarketingAgendamentoService(
      {
        marketingNotificationAuditLog: log,
        adminPanelUser: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService,
      audit as unknown as MarketingNotificationAuditService,
      notifications as unknown as NotificationsService,
      fila as unknown as Queue,
    );
  });

  describe('agendar', () => {
    it('registra quem agendou, cria o job atrasado e não envia nada', async () => {
      const agendarPara = emMinutos(30);
      const dto = { title: 'T', body: 'B', agendarPara };

      const r = await service.agendar(dto, 3);

      expect(audit.createRequestAudit).toHaveBeenCalledWith(3, dto, {
        agendarPara: new Date(agendarPara),
      });
      expect(fila.add).toHaveBeenCalledWith(
        'enviar-marketing-agendada',
        { auditId: 7 },
        expect.objectContaining({
          jobId: 'marketing-agendada-7',
          attempts: 1,
        }),
      );
      const delay = fila.add.mock.calls[0][2].delay as number;
      expect(delay).toBeGreaterThan(29 * 60_000);
      expect(delay).toBeLessThanOrEqual(30 * 60_000);
      expect(notifications.sendMarketingNotification).not.toHaveBeenCalled();
      expect(r).toEqual({
        agendado: true,
        id: 7,
        agendarPara,
        sentCount: 0,
        skippedCount: 0,
      });
    });

    it.each([
      ['passado', -5],
      ['menos de 1 minuto', 0.5],
      ['mais de 1 ano', 366 * 24 * 60],
    ])('recusa data no %s', async (_nome, minutos) => {
      await expect(
        service.agendar(
          { title: 'T', body: 'B', agendarPara: emMinutos(minutos) },
          3,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(audit.createRequestAudit).not.toHaveBeenCalled();
      expect(fila.add).not.toHaveBeenCalled();
    });

    it('sem registro de auditoria (usuário não identificado) não agenda', async () => {
      audit.createRequestAudit.mockResolvedValue(null);
      await expect(
        service.agendar(
          { title: 'T', body: 'B', agendarPara: emMinutos(30) },
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(fila.add).not.toHaveBeenCalled();
    });
  });

  describe('executar', () => {
    it('envia com o mesmo serviço do disparo imediato e marca sucesso', async () => {
      await service.executar(7);

      expect(log.updateMany).toHaveBeenCalledWith({
        where: { id: 7, status: 'SCHEDULED' },
        data: { status: 'SENDING' },
      });
      expect(notifications.sendMarketingNotification).toHaveBeenCalledWith(
        {
          title: 'Título',
          body: 'Corpo',
          data: { type: 'external_link', url: 'https://x' },
        },
        3,
      );
      expect(audit.markSuccess).toHaveBeenCalledWith(7, 10, 2);
    });

    it('cancelado ou já enviado: não envia', async () => {
      log.updateMany.mockResolvedValue({ count: 0 });
      await service.executar(7);
      expect(notifications.sendMarketingNotification).not.toHaveBeenCalled();
      expect(audit.markSuccess).not.toHaveBeenCalled();
    });

    it('erro no envio vira FAILED, sem lançar', async () => {
      notifications.sendMarketingNotification.mockRejectedValue(
        new Error('Expo fora do ar'),
      );
      await expect(service.executar(7)).resolves.toBeUndefined();
      expect(audit.markFailure).toHaveBeenCalledWith(7, 'Expo fora do ar');
    });
  });

  describe('cancelar', () => {
    it('cancela, registra quem cancelou e remove o job', async () => {
      const r = await service.cancelar(7, 9);

      expect(log.updateMany).toHaveBeenCalledWith({
        where: { id: 7, status: 'SCHEDULED' },
        data: expect.objectContaining({
          status: 'CANCELED',
          canceledByAdminPanelUserId: 9,
        }),
      });
      expect(fila.remove).toHaveBeenCalledWith('marketing-agendada-7');
      expect(r).toEqual({ cancelado: true, id: 7 });
    });

    it('já enviado/em envio: 409 e o job não é mexido', async () => {
      log.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancelar(7, 9)).rejects.toThrow(ConflictException);
      expect(fila.remove).not.toHaveBeenCalled();
    });
  });

  describe('reconciliarPendentes (boot)', () => {
    it('recria job do pendente, descarta o vencido há muito e fecha interrompidos', async () => {
      log.updateMany.mockResolvedValue({ count: 1 });
      log.findMany.mockResolvedValue([
        { id: 1, scheduledFor: new Date(Date.now() + 60 * 60_000) },
        { id: 2, scheduledFor: new Date(Date.now() - 10 * 60_000) },
        { id: 3, scheduledFor: new Date(Date.now() - 7 * 60 * 60_000) },
      ]);

      const r = await service.reconciliarPendentes();

      expect(r).toEqual({ agendados: 2, perdidos: 1, interrompidos: 1 });
      expect(fila.add.mock.calls.map((c) => c[2].jobId)).toEqual([
        'marketing-agendada-1',
        'marketing-agendada-2',
      ]);
      // Vencido dentro da tolerância sai imediatamente.
      expect(fila.add.mock.calls[1][2].delay).toBe(0);
      expect(log.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 3, status: 'SCHEDULED' },
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('job que já existe no Redis não é duplicado', async () => {
      fila.getJob.mockResolvedValue({ id: 'marketing-agendada-1' });
      log.findMany.mockResolvedValue([
        { id: 1, scheduledFor: new Date(Date.now() + 60 * 60_000) },
      ]);
      await service.reconciliarPendentes();
      expect(fila.add).not.toHaveBeenCalled();
    });
  });
});

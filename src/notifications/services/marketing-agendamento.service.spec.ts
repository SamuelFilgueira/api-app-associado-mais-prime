import { BadRequestException, ConflictException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import {
  CenarioDePushEmMassa,
  montarCenarioDePushEmMassa,
  tokenDe,
} from 'src/notifications/testing/cenario-push-massa';
import { MARKETING_AGENDADA_QUEUE } from 'src/queue/filas';

describe('MarketingAgendamentoService', () => {
  let log: {
    updateMany: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  let audit: { createRequestAudit: jest.Mock };
  let fila: { getJob: jest.Mock; remove: jest.Mock };
  let cenario: CenarioDePushEmMassa;
  let service: MarketingAgendamentoService;

  const emMinutos = (min: number) =>
    new Date(Date.now() + min * 60_000).toISOString();
  const despertadores = () => cenario.produtor.da(MARKETING_AGENDADA_QUEUE);

  beforeEach(() => {
    cenario = montarCenarioDePushEmMassa();
    log = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 7, status: 'SCHEDULED' }),
      findMany: jest.fn().mockResolvedValue([]),
    };
    audit = { createRequestAudit: jest.fn().mockResolvedValue(7) };
    fila = {
      getJob: jest.fn().mockResolvedValue(null),
      remove: jest.fn().mockResolvedValue(1),
    };
    service = new MarketingAgendamentoService(
      {
        marketingNotificationAuditLog: log,
        adminPanelUser: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService,
      audit as unknown as MarketingNotificationAuditService,
      cenario.repo.comoRepositorio(),
      cenario.disparos,
      cenario.produtor.comoProdutor(),
      cenario.trava.comoTrava(),
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
      expect(despertadores()).toHaveLength(1);
      const [job] = despertadores();
      expect(job).toMatchObject({
        id: 'marketing-agendada-7',
        nome: 'enviar-marketing-agendada',
        dados: { auditId: 7 },
      });
      // Sem `attempts` no job: vale o retry padrão da fila (5 tentativas).
      expect(job.opcoes.opcoes).toEqual({ removeOnComplete: true });
      expect(job.opcoes.atrasoMs).toBeGreaterThan(29 * 60_000);
      expect(job.opcoes.atrasoMs).toBeLessThanOrEqual(30 * 60_000);
      expect(cenario.repo.disparos).toHaveLength(0);
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
      expect(despertadores()).toHaveLength(0);
    });

    it('sem registro de auditoria (usuário não identificado) não agenda', async () => {
      audit.createRequestAudit.mockResolvedValue(null);
      await expect(
        service.agendar(
          { title: 'T', body: 'B', agendarPara: emMinutos(30) },
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(despertadores()).toHaveLength(0);
    });

    it('duplo clique em "Agendar" (mesmo texto, carga e horário): devolve o agendamento que já existe', async () => {
      const agendarPara = emMinutos(30);
      const dto = {
        title: 'T',
        body: 'B',
        data: { type: 'external_link' as const, url: 'https://x' },
        agendarPara,
      };
      log.findMany.mockResolvedValue([
        // Mesmo título e horário, corpo diferente: não é o mesmo.
        { id: 4, body: 'Outro', messagePayload: dto.data },
        {
          id: 5,
          body: 'B',
          messagePayload: { url: 'https://x', type: 'external_link' },
        },
      ]);

      const r = await service.agendar(dto, 3);

      expect(log.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'SCHEDULED',
            tipo: 'MARKETING',
            title: 'T',
            scheduledFor: new Date(agendarPara),
          },
        }),
      );
      expect(audit.createRequestAudit).not.toHaveBeenCalled();
      expect(r).toMatchObject({ agendado: true, id: 5, repetido: true });
      expect(despertadores().map((j) => j.id)).toEqual([
        'marketing-agendada-5',
      ]);
    });
  });

  describe('executar (job na hora marcada)', () => {
    const agendado = () =>
      cenario.repo.comLog({
        id: 7,
        status: 'SCHEDULED',
        title: 'Título',
        body: 'Corpo',
        messagePayload: { type: 'external_link', url: 'https://x' },
      });

    it('reivindica o agendamento, cria o disparo ligado ao log e enfileira os lotes — o job não envia', async () => {
      const registro = agendado();
      cenario.repo.comUsuarios(250, tokenDe);

      await service.executar(7);

      expect(registro.status).toBe('SENDING');
      expect(cenario.repo.disparos).toHaveLength(1);
      expect(cenario.repo.disparo(1)).toMatchObject({
        tipo: 'MARKETING',
        marketingAuditLogId: 7,
        titulo: 'Título',
        corpo: 'Corpo',
        dados: { type: 'external_link', url: 'https://x' },
        estado: 'ENVIANDO',
        totalDestinatarios: 250,
      });
      expect(cenario.jobsDeLote()).toHaveLength(3);
      expect(cenario.gateway.chamadas).toHaveLength(0);

      // O envio é dos lotes; ao fim, o log do painel fecha com a contagem real.
      await cenario.executarLotes();
      expect(registro).toMatchObject({
        status: 'SENT',
        sentCount: 250,
        skippedCount: 0,
      });
    });

    it('cancelado ou já enviado: não cria disparo', async () => {
      agendado().status = 'CANCELED';
      cenario.repo.comUsuarios(5, tokenDe);

      await expect(service.executar(7)).resolves.toBeUndefined();

      expect(cenario.repo.disparos).toHaveLength(0);
      expect(cenario.produtor.jobs).toHaveLength(0);
    });

    it('`SENDING` de antes do envio por lotes (log sem disparo): não reenvia', async () => {
      agendado().status = 'SENDING';
      cenario.repo.comUsuarios(5, tokenDe);

      await service.executar(7);

      expect(cenario.repo.disparos).toHaveLength(0);
    });

    it('falha no meio LANÇA (o job repete) e a nova tentativa continua do mesmo disparo', async () => {
      const registro = agendado();
      cenario.repo.comUsuarios(250, tokenDe);
      const criarEntregas = cenario.repo.criarEntregas.bind(cenario.repo);
      cenario.repo.criarEntregas = () =>
        Promise.reject(new Error('ECONNRESET: banco fora'));

      await expect(service.executar(7)).rejects.toThrow('banco fora');

      // Nada se perdeu: o log segue em envio, com o disparo criado e parado.
      expect(registro.status).toBe('SENDING');
      expect(cenario.repo.disparo(1).estado).toBe('CRIADO');
      expect(cenario.produtor.jobs).toHaveLength(0);

      cenario.repo.criarEntregas = criarEntregas;
      await service.executar(7);

      expect(cenario.repo.disparos).toHaveLength(1);
      expect(cenario.repo.disparo(1).estado).toBe('ENVIANDO');
      expect(cenario.repo.entregasDo(1)).toHaveLength(250);
      expect(cenario.jobsDeLote()).toHaveLength(3);
    });

    it('job reexecutado depois de enfileirar ("stalled"): nem outro disparo, nem outros lotes, nem push em dobro', async () => {
      agendado();
      cenario.repo.comUsuarios(250, tokenDe);

      await service.executar(7);
      await cenario.executarLotes();
      await service.executar(7);
      await cenario.executarLotes();

      expect(cenario.repo.disparos).toHaveLength(1);
      expect(cenario.jobsDeLote()).toHaveLength(3);
      expect(cenario.gateway.totalDeMensagens()).toBe(250);
      expect(cenario.repo.notificacoes).toHaveLength(250);
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

  describe('reconciliarPendentes (varredura periódica)', () => {
    it('recria o despertador do pendente e fecha o vencido há mais de 6 h', async () => {
      log.findMany.mockResolvedValue([
        { id: 1, scheduledFor: new Date(Date.now() + 60 * 60_000) },
        { id: 2, scheduledFor: new Date(Date.now() - 10 * 60_000) },
        { id: 3, scheduledFor: new Date(Date.now() - 7 * 60 * 60_000) },
      ]);

      const r = await service.reconciliarPendentes();

      expect(r).toEqual({ agendados: 2, perdidos: 1 });
      expect(despertadores().map((j) => j.id)).toEqual([
        'marketing-agendada-1',
        'marketing-agendada-2',
      ]);
      // Vencido dentro da tolerância sai imediatamente.
      expect(despertadores()[1].opcoes.atrasoMs).toBe(0);
      expect(log.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 3, status: 'SCHEDULED' },
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('job que já existe no Redis, ainda por rodar, não é duplicado', async () => {
      fila.getJob.mockResolvedValue({
        getState: jest.fn().mockResolvedValue('delayed'),
        remove: jest.fn(),
      });
      log.findMany.mockResolvedValue([
        { id: 1, scheduledFor: new Date(Date.now() + 60 * 60_000) },
      ]);

      await service.reconciliarPendentes();

      expect(despertadores()).toHaveLength(0);
    });

    it('job que esgotou as tentativas, com o disparo ainda agendado, é trocado por um novo', async () => {
      const esgotado = {
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn().mockResolvedValue(undefined),
      };
      fila.getJob.mockResolvedValue(esgotado);
      log.findMany.mockResolvedValue([
        { id: 1, scheduledFor: new Date(Date.now() - 60_000) },
      ]);

      await service.reconciliarPendentes();

      expect(esgotado.remove).toHaveBeenCalled();
      expect(despertadores().map((j) => j.id)).toEqual([
        'marketing-agendada-1',
      ]);
    });
  });
});

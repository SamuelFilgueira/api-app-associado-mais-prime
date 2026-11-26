import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import {
  BoletoNotificacaoSchedulerService,
  TIMEZONE_ROTINA,
} from 'src/boleto-notificacao/services/boleto-notificacao-scheduler.service';
import { resetAppConfig } from 'src/config/app.config';

/** Agendamento da régua diária: no boot, só o papel `worker` o registra. */
describe('BoletoNotificacaoSchedulerService — papel do processo (APP_ROLE)', () => {
  const papelOriginal = process.env.APP_ROLE;
  let queue: {
    getRepeatableJobs: jest.Mock;
    removeRepeatableByKey: jest.Mock;
    add: jest.Mock;
  };
  let service: BoletoNotificacaoSchedulerService;

  const definirPapel = (papel: string | undefined) => {
    if (papel === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = papel;
    resetAppConfig();
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    queue = {
      getRepeatableJobs: jest
        .fn()
        .mockResolvedValue([{ name: 'executar-rotina', key: 'chave-antiga' }]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(true),
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };
    service = new BoletoNotificacaoSchedulerService(
      queue as unknown as Queue,
      {
        get: () => ({ enabled: true, cronPattern: '0 9 * * *', horario: '09' }),
      } as unknown as BoletoNotificacaoConfigService,
    );
  });

  afterEach(() => {
    definirPapel(papelOriginal);
    jest.restoreAllMocks();
  });

  it.each(['api', 'pdf'])(
    'papel %s: o boot não remove nem registra o agendamento',
    async (papel) => {
      definirPapel(papel);

      await service.onApplicationBootstrap();

      expect(queue.getRepeatableJobs).not.toHaveBeenCalled();
      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('papel api: a sincronização pedida pelo painel continua funcionando', async () => {
    definirPapel('api');

    await expect(service.sincronizarAgendamento()).resolves.toEqual({
      enabled: true,
      cron: '0 9 * * *',
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it.each(['worker', undefined])(
    'papel %s: o boot troca o agendamento antigo pelo atual; tentativas, backoff e retenção ficam com o padrão da fila',
    async (papel) => {
      definirPapel(papel);

      await service.onApplicationBootstrap();

      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-antiga');
      expect(queue.add).toHaveBeenCalledWith(
        'executar-rotina',
        { origem: 'AGENDADA' },
        {
          repeat: { pattern: '0 9 * * *', tz: TIMEZONE_ROTINA },
          jobId: 'boleto-notificacao-diaria',
        },
      );
    },
  );
});

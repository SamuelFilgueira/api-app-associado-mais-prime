import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { JOURNEY_CLEANUP_SCHEDULER_ID } from 'src/analytics/constants/analytics-journey.constants';
import { AnalyticsJornadaExpurgoService } from 'src/analytics/services/analytics-jornada-expurgo.service';
import {
  AnalyticsJourneyService,
  ROTINA_DE_EXPURGO_DA_JORNADA,
} from 'src/analytics/services/analytics-journey.service';
import { resetAppConfig } from 'src/config/app.config';
import { PrismaService } from 'src/database/prisma.service';
import { ExpurgoService } from 'src/infra/manutencao/expurgo.service';

/** Limpeza da jornada: só o papel `worker` a registra na manutenção. */
describe('AnalyticsJourneyService — limpeza da jornada (APP_ROLE)', () => {
  const papelOriginal = process.env.APP_ROLE;
  const flagOriginal = process.env.ANALYTICS_JOURNEY_ENABLED;
  let fila: { upsertJobScheduler: jest.Mock; removeJobScheduler: jest.Mock };
  let service: AnalyticsJourneyService;

  const definirPapel = (papel: string | undefined) => {
    if (papel === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = papel;
    resetAppConfig();
  };

  let manutencao: { registrarRotina: jest.Mock };
  let expurgoDaJornada: { expurgarJornada: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    fila = {
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    manutencao = { registrarRotina: jest.fn() };
    expurgoDaJornada = {
      expurgarJornada: jest.fn().mockResolvedValue({ removidos: 42 }),
    };
    service = new AnalyticsJourneyService(
      {} as PrismaService,
      fila as unknown as Queue,
      manutencao as unknown as ExpurgoService,
      expurgoDaJornada as unknown as AnalyticsJornadaExpurgoService,
    );
  });

  afterEach(() => {
    if (flagOriginal === undefined) {
      delete process.env.ANALYTICS_JOURNEY_ENABLED;
    } else {
      process.env.ANALYTICS_JOURNEY_ENABLED = flagOriginal;
    }
    definirPapel(papelOriginal);
    jest.restoreAllMocks();
  });

  it.each([
    ['api', 'true'],
    ['api', 'false'],
    ['pdf', 'true'],
    ['pdf', 'false'],
  ])(
    'papel %s com ANALYTICS_JOURNEY_ENABLED=%s: não registra a limpeza nem toca em agendador',
    async (papel, flag) => {
      process.env.ANALYTICS_JOURNEY_ENABLED = flag;
      definirPapel(papel);

      await service.onModuleInit();

      expect(manutencao.registrarRotina).not.toHaveBeenCalled();
      expect(fila.upsertJobScheduler).not.toHaveBeenCalled();
      expect(fila.removeJobScheduler).not.toHaveBeenCalled();
    },
  );

  it('papel worker com a flag ligada: a limpeza entra na rotina de manutenção e o agendador antigo é removido', async () => {
    process.env.ANALYTICS_JOURNEY_ENABLED = 'true';
    definirPapel('worker');

    await service.onModuleInit();

    expect(manutencao.registrarRotina).toHaveBeenCalledWith(
      ROTINA_DE_EXPURGO_DA_JORNADA,
      expect.any(Function),
    );
    expect(fila.upsertJobScheduler).not.toHaveBeenCalled();
    expect(fila.removeJobScheduler).toHaveBeenCalledWith(
      JOURNEY_CLEANUP_SCHEDULER_ID,
    );

    // A rotina registrada devolve quantos eventos apagou.
    const rotina = manutencao.registrarRotina.mock.calls[0][1] as (
      agora: Date,
    ) => Promise<number>;
    const agora = new Date('2026-11-26T06:30:00Z');
    await expect(rotina(agora)).resolves.toBe(42);
    expect(expurgoDaJornada.expurgarJornada).toHaveBeenCalledWith(agora);
  });

  it('papel worker com a flag desligada: não registra a limpeza e remove o agendador antigo', async () => {
    process.env.ANALYTICS_JOURNEY_ENABLED = 'false';
    definirPapel('worker');

    await service.onModuleInit();

    expect(manutencao.registrarRotina).not.toHaveBeenCalled();
    expect(fila.removeJobScheduler).toHaveBeenCalledWith(
      JOURNEY_CLEANUP_SCHEDULER_ID,
    );
  });

  it('falha ao remover o agendador antigo não derruba o boot', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.ANALYTICS_JOURNEY_ENABLED = 'true';
    definirPapel('worker');
    fila.removeJobScheduler.mockRejectedValueOnce(new Error('redis fora'));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(manutencao.registrarRotina).toHaveBeenCalledTimes(1);
  });
});

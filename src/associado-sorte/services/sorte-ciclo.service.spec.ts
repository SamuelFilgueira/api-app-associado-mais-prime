import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import {
  associadoSorteConfig,
  SORTE_CICLO_JOB,
  SORTE_CICLO_SCHEDULER_ID,
} from 'src/associado-sorte/config/associado-sorte.config';
import { SorteCicloProcessor } from 'src/associado-sorte/processors/sorte-ciclo.processor';
import { SorteCicloService } from 'src/associado-sorte/services/sorte-ciclo.service';
import { SorteNotificacoesAdminService } from 'src/associado-sorte/services/sorte-notificacoes-admin.service';

/** Agendador do Associado da Sorte: desligado por padrão e silencioso. */
describe('Associado da Sorte — agendador', () => {
  const envOriginal = process.env.ASSOCIADO_SORTE_AGENDADOR;
  let fila: { upsertJobScheduler: jest.Mock; removeJobScheduler: jest.Mock };
  let service: SorteCicloService;

  beforeEach(() => {
    fila = {
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    service = new SorteCicloService(
      fila as unknown as Queue,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterEach(() => {
    if (envOriginal === undefined) delete process.env.ASSOCIADO_SORTE_AGENDADOR;
    else process.env.ASSOCIADO_SORTE_AGENDADOR = envOriginal;
    jest.restoreAllMocks();
  });

  it.each([undefined, '', 'false', 'FALSE', 'sim', '1'])(
    'ASSOCIADO_SORTE_AGENDADOR=%p → desligado',
    (valor) => {
      if (valor === undefined) delete process.env.ASSOCIADO_SORTE_AGENDADOR;
      else process.env.ASSOCIADO_SORTE_AGENDADOR = valor;
      expect(associadoSorteConfig().agendadorAtivo).toBe(false);
    },
  );

  it('só "true" liga', () => {
    process.env.ASSOCIADO_SORTE_AGENDADOR = ' True ';
    expect(associadoSorteConfig().agendadorAtivo).toBe(true);
  });

  it('desligado: remove o agendador do Redis, não agenda e não loga', async () => {
    delete process.env.ASSOCIADO_SORTE_AGENDADOR;
    const log = jest.spyOn(Logger.prototype, 'log');
    const warn = jest.spyOn(Logger.prototype, 'warn');

    await service.onModuleInit();

    expect(fila.removeJobScheduler).toHaveBeenCalledWith(
      SORTE_CICLO_SCHEDULER_ID,
    );
    expect(fila.upsertJobScheduler).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('desligado e Redis fora do ar: boot segue sem alerta', async () => {
    delete process.env.ASSOCIADO_SORTE_AGENDADOR;
    fila.removeJobScheduler.mockRejectedValue(new Error('ECONNREFUSED'));
    const warn = jest.spyOn(Logger.prototype, 'warn');

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ligado: registra o agendador de 5 s', async () => {
    process.env.ASSOCIADO_SORTE_AGENDADOR = 'true';

    await service.onModuleInit();

    expect(fila.upsertJobScheduler).toHaveBeenCalledWith(
      SORTE_CICLO_SCHEDULER_ID,
      { every: 5_000 },
      expect.objectContaining({ name: SORTE_CICLO_JOB }),
    );
  });

  it('desligado: job de ciclo que sobrou no Redis é descartado sem executar', async () => {
    delete process.env.ASSOCIADO_SORTE_AGENDADOR;
    const executar = jest.fn();
    const processor = new SorteCicloProcessor(
      { executar } as unknown as SorteCicloService,
      {} as SorteNotificacoesAdminService,
    );

    await expect(
      processor.process({ name: SORTE_CICLO_JOB } as Job),
    ).resolves.toBeNull();
    expect(executar).not.toHaveBeenCalled();
  });
});

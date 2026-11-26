import { Job, Queue } from 'bullmq';
import {
  JOB_VARREDURA_PUSH,
  MarketingAgendadaProcessor,
} from 'src/notifications/processors/marketing-agendada.processor';
import {
  MarketingAgendadaJobData,
  MarketingAgendamentoService,
} from 'src/notifications/services/marketing-agendamento.service';
import { PushVarreduraService } from 'src/notifications/services/push-varredura.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { OPCOES_POR_FILA, RETRY_PADRAO } from 'src/queue/filas';
import {
  MARKETING_AGENDADA_QUEUE,
  NOTIFICATION_QUEUE,
  PUSH_MASSA_QUEUE,
} from 'src/queue/filas';

describe('MarketingAgendadaProcessor', () => {
  function montar() {
    const agendamento = { executar: jest.fn().mockResolvedValue(undefined) };
    const varredura = {
      executar: jest.fn().mockResolvedValue({ retomados: 0 }),
    };
    const fila = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
    const processor = new MarketingAgendadaProcessor(
      agendamento as unknown as MarketingAgendamentoService,
      varredura as unknown as PushVarreduraService,
      fila as unknown as Queue,
      { receber: jest.fn() } as unknown as FilaDeMortosService,
    );
    const job = (name: string, data: unknown) =>
      ({
        id: '1',
        name,
        queueName: MARKETING_AGENDADA_QUEUE,
        attemptsMade: 0,
        data,
      }) as unknown as Job<MarketingAgendadaJobData>;
    return { processor, agendamento, varredura, fila, job };
  }

  afterEach(() => jest.useRealTimers());

  it('no boot do worker registra a varredura a cada minuto (no lugar da reconciliação de boot)', async () => {
    const { processor, fila, agendamento, varredura } = montar();

    await processor.onApplicationBootstrap();

    expect(fila.upsertJobScheduler).toHaveBeenCalledWith(
      'push-varredura',
      { every: 60_000 },
      {
        name: JOB_VARREDURA_PUSH,
        opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 50 },
      },
    );
    // Nada é reconciliado nem enviado no boot.
    expect(agendamento.executar).not.toHaveBeenCalled();
    expect(varredura.executar).not.toHaveBeenCalled();
  });

  it('Redis fora no boot: não derruba o processo e tenta registrar de novo', async () => {
    jest.useFakeTimers();
    const { processor, fila } = montar();
    fila.upsertJobScheduler.mockRejectedValueOnce(new Error('Redis fora'));

    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(fila.upsertJobScheduler).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(fila.upsertJobScheduler).toHaveBeenCalledTimes(2);
    processor.onModuleDestroy();
  });

  it('job do agendamento delega ao service; job da varredura, à varredura', async () => {
    const { processor, agendamento, varredura, job } = montar();

    await processor.process(job('enviar-marketing-agendada', { auditId: '7' }));
    await processor.process(job(JOB_VARREDURA_PUSH, {}));

    expect(agendamento.executar).toHaveBeenCalledWith(7);
    expect(varredura.executar).toHaveBeenCalledTimes(1);
  });

  it('falha ao criar o disparo sobe para o BullMQ (retry), não é engolida', async () => {
    const { processor, agendamento, job } = montar();
    agendamento.executar.mockRejectedValue(new Error('ECONNRESET: banco fora'));

    await expect(
      processor.process(job('enviar-marketing-agendada', { auditId: 7 })),
    ).rejects.toThrow('banco fora');
  });
});

describe('retry das filas de push', () => {
  it.each([NOTIFICATION_QUEUE, MARKETING_AGENDADA_QUEUE, PUSH_MASSA_QUEUE])(
    '%s usa o retry padrão: 5 tentativas com backoff exponencial e jitter',
    (fila) => {
      expect(OPCOES_POR_FILA[fila]).toMatchObject(RETRY_PADRAO);
      expect(OPCOES_POR_FILA[fila]).toMatchObject({
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 },
      });
    },
  );
});

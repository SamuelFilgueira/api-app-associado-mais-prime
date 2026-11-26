import { Logger } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { BoletoNotificacaoSchedulerService } from 'src/boleto-notificacao/services/boleto-notificacao-scheduler.service';
import { BOLETO_NOTIFICACAO_QUEUE, OPCOES_POR_FILA } from 'src/queue/filas';
import { describeComRedis, opcoesDoRedisDeTeste } from './ambiente';

const PREFIXO = `it-regua-${process.pid}`;

const esperar = async (condicao: () => boolean, prazoMs = 15_000) => {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) {
    if (condicao()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condição não atingida no prazo');
};

/**
 * Fila da régua com BullMQ real: confere o que o código só supõe sobre o
 * BullMQ — que a ocorrência do agendamento herda o retry padrão da fila e
 * que o progresso gravado numa ocorrência não passa para a seguinte.
 */
describeComRedis('BullMQ real — fila da régua de boletos', () => {
  const filas: Queue[] = [];
  const workers: Worker[] = [];

  const criarFila = (nome: string, opcoes = {}) => {
    const fila = new Queue(nome, {
      connection: opcoesDoRedisDeTeste(),
      prefix: PREFIXO,
      ...opcoes,
    });
    filas.push(fila);
    return fila;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    for (const worker of workers) await worker.close();
    for (const fila of filas) {
      await fila.obliterate({ force: true });
      await fila.close();
    }
  });

  it('agendamento diário: a ocorrência nasce com 3 tentativas e backoff de minutos (padrão da fila), sem opções repetidas', async () => {
    const fila = criarFila(BOLETO_NOTIFICACAO_QUEUE, {
      defaultJobOptions: OPCOES_POR_FILA[BOLETO_NOTIFICACAO_QUEUE],
    });
    const scheduler = new BoletoNotificacaoSchedulerService(fila, {
      get: () => ({
        enabled: true,
        cronPattern: '0 11 * * *',
        horario: '11:00',
      }),
    } as unknown as BoletoNotificacaoConfigService);

    await scheduler.sincronizarAgendamento();
    // Sincronizar de novo (outro boot) não duplica o agendamento.
    await scheduler.sincronizarAgendamento();

    expect(await fila.getRepeatableJobs()).toHaveLength(1);
    const ocorrencias = await fila.getDelayed();
    expect(ocorrencias).toHaveLength(1);
    const [ocorrencia] = ocorrencias;
    expect(ocorrencia.name).toBe('executar-rotina');
    expect(ocorrencia.data).toEqual({ origem: 'AGENDADA' });
    expect(ocorrencia.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 10 * 60_000 },
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail: { age: 7 * 86_400, count: 5_000 },
      repeat: { pattern: '0 11 * * *', tz: 'America/Sao_Paulo' },
    });

    const status = await scheduler.statusAgendamento();
    expect(status).toMatchObject({ enabled: true, registradoNoRedis: true });
  });

  it('progresso gravado numa ocorrência sobrevive ao retry DELA e não passa para a ocorrência seguinte', async () => {
    const nome = `${BOLETO_NOTIFICACAO_QUEUE}-progresso`;
    const fila = criarFila(nome, {
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 50 },
      },
    });
    const vistos: Array<{
      id: string;
      tentativa: number;
      progresso: unknown;
    }> = [];
    const worker = new Worker(
      nome,
      async (job: Job<Record<string, unknown>>) => {
        vistos.push({
          id: job.id as string,
          tentativa: job.attemptsMade + 1,
          progresso: job.data.progresso ?? null,
        });
        if (job.attemptsMade === 0) {
          // O que o processor faz quando a régua sai incompleta.
          await job.updateData({
            ...job.data,
            progresso: {
              dataReferencia: '10/09/2026',
              basesConcluidas: ['MAIS_PRIME_RS'],
            },
          });
          throw new Error('régua incompleta');
        }
      },
      { connection: opcoesDoRedisDeTeste(), prefix: PREFIXO },
    );
    workers.push(worker);

    await fila.add(
      'executar-rotina',
      { origem: 'AGENDADA' },
      { repeat: { every: 400 }, jobId: 'boleto-notificacao-diaria' },
    );

    // Duas ocorrências completas: cada uma com a tentativa 1 e o retry.
    await esperar(
      () => new Set(vistos.map((v) => v.id)).size >= 2 && vistos.length >= 4,
    );
    await worker.pause();

    const ids = Array.from(new Set(vistos.map((v) => v.id)));
    const daOcorrencia = (id: string) => vistos.filter((v) => v.id === id);

    expect(daOcorrencia(ids[0]).slice(0, 2)).toEqual([
      { id: ids[0], tentativa: 1, progresso: null },
      {
        id: ids[0],
        tentativa: 2,
        progresso: {
          dataReferencia: '10/09/2026',
          basesConcluidas: ['MAIS_PRIME_RS'],
        },
      },
    ]);
    // A ocorrência seguinte começa limpa.
    expect(daOcorrencia(ids[1])[0]).toEqual({
      id: ids[1],
      tentativa: 1,
      progresso: null,
    });
  });
});

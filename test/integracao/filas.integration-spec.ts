import { BullModule, Processor, getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Job, Queue } from 'bullmq';
import { contextoExecucao } from 'src/infra/observability/contexto-execucao';
import {
  FilaDeMortosService,
  JobMorto,
} from 'src/queue/fila-de-mortos.service';
import { FILA_DE_MORTOS, MANUTENCAO_QUEUE } from 'src/queue/filas';
import { comEnvelope } from 'src/queue/job-envelope';
import { ProcessadorBase } from 'src/queue/processador-base';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { DomainError } from 'src/shared/erros/erros';
import { describeComRedis, opcoesDoRedisDeTeste } from './ambiente';

interface DadosDeTeste {
  comportamento: 'ok' | 'transitorio' | 'definitivo';
  baseOrigin?: string;
}

const execucoes: Array<{ id?: string; tentativa: number; contexto: unknown }> =
  [];

@Injectable()
@Processor(MANUTENCAO_QUEUE)
class ProcessadorDeTeste extends ProcessadorBase<DadosDeTeste, string> {
  protected readonly logger = new Logger('ProcessadorDeTeste');

  constructor(filaDeMortos: FilaDeMortosService) {
    super(filaDeMortos);
  }

  protected executar(job: Job<DadosDeTeste>): Promise<string> {
    execucoes.push({
      id: job.id,
      tentativa: job.attemptsMade + 1,
      contexto: { ...contextoExecucao.atual() },
    });
    switch (job.data.comportamento) {
      case 'transitorio':
        return Promise.reject(new Error('ECONNRESET: vendor fora'));
      case 'definitivo':
        return Promise.reject(
          new DomainError('BOLETO_JA_PAGO', 'Boleto já pago', { status: 409 }),
        );
      default:
        return Promise.resolve('feito');
    }
  }
}

const esperar = async (condicao: () => Promise<boolean>, prazoMs = 15_000) => {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no prazo');
};

describeComRedis(
  'Filas com BullMQ real — retry, erro definitivo e fila de mortos',
  () => {
    let modulo: TestingModule;
    let fila: Queue;
    let mortos: Queue<JobMorto>;
    let filaDeMortos: FilaDeMortosService;
    let produtor: ProdutorDeFilas;

    beforeAll(async () => {
      modulo = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({
            connection: opcoesDoRedisDeTeste(),
            prefix: `it-filas-${process.pid}`,
          }),
          BullModule.registerQueue(
            { name: MANUTENCAO_QUEUE },
            { name: FILA_DE_MORTOS },
          ),
        ],
        providers: [FilaDeMortosService, ProdutorDeFilas, ProcessadorDeTeste],
      }).compile();
      modulo.useLogger(false);
      await modulo.init();

      fila = modulo.get(getQueueToken(MANUTENCAO_QUEUE));
      mortos = modulo.get(getQueueToken(FILA_DE_MORTOS));
      filaDeMortos = modulo.get(FilaDeMortosService);
      produtor = modulo.get(ProdutorDeFilas);
    });

    afterAll(async () => {
      await fila.obliterate({ force: true });
      await mortos.obliterate({ force: true });
      await modulo.close();
    });

    beforeEach(() => {
      execucoes.length = 0;
    });

    const mortosDe = async (id: string) =>
      (await mortos.getJobs(['waiting'])).filter(
        (job) => job.data.jobIdOriginal === id,
      );

    it('job que dá certo: o contexto de log carrega fila, job, base e o requestId de quem enfileirou', async () => {
      const job = await contextoExecucao.executar(
        { requestId: 'req-origem-001' },
        () =>
          produtor.enfileirar(
            MANUTENCAO_QUEUE,
            'limpar',
            { comportamento: 'ok' as const },
            { base: 'MAIS_PRIME' },
          ),
      );

      await esperar(async () => (await job.getState()) === 'completed');

      expect(execucoes[0].contexto).toMatchObject({
        requestId: 'req-origem-001',
        base: 'MAIS_PRIME',
        queue: MANUTENCAO_QUEUE,
        jobName: 'limpar',
        jobId: job.id,
      });
      expect(await mortosDe(job.id!)).toHaveLength(0);
    });

    it('erro transitório: repete até esgotar e só então vai para a fila de mortos, com o payload intacto', async () => {
      const dados = comEnvelope(
        { comportamento: 'transitorio' as const },
        'MAIS_PRIME_RS',
      );
      const job = await fila.add('sincronizar', dados, {
        attempts: 3,
        backoff: { type: 'fixed', delay: 50 },
      });

      await esperar(async () => (await mortosDe(job.id!)).length === 1);

      expect(execucoes.map((e) => e.tentativa)).toEqual([1, 2, 3]);
      const [morto] = await mortosDe(job.id!);
      expect(morto.name).toBe(MANUTENCAO_QUEUE);
      expect(morto.data).toMatchObject({
        fila: MANUTENCAO_QUEUE,
        nome: 'sincronizar',
        causa: 'esgotado',
        tentativas: 3,
        baseOrigin: 'MAIS_PRIME_RS',
        motivo: 'ECONNRESET: vendor fora',
        // O payload guardado é o que trafegou: JSON, sem campos `undefined`.
        dados: JSON.parse(JSON.stringify(dados)) as unknown,
      });
    });

    it('erro de regra de negócio: uma tentativa só, direto para a fila de mortos', async () => {
      const job = await fila.add(
        'reativar',
        { comportamento: 'definitivo' },
        { attempts: 5, backoff: { type: 'fixed', delay: 50 } },
      );

      await esperar(async () => (await mortosDe(job.id!)).length === 1);

      expect(execucoes).toHaveLength(1);
      const [morto] = await mortosDe(job.id!);
      expect(morto.data).toMatchObject({
        causa: 'definitivo',
        motivo: 'Boleto já pago',
      });
    });

    it('o mesmo job não entra duas vezes na fila de mortos', async () => {
      const job = await fila.add('x', { comportamento: 'definitivo' });
      await esperar(async () => (await mortosDe(job.id!)).length === 1);

      const falho = await Job.fromId(fila, job.id!);
      await filaDeMortos.receber(
        falho!,
        Object.assign(new Error('de novo'), { name: 'UnrecoverableError' }),
      );

      expect(await mortosDe(job.id!)).toHaveLength(1);
    });

    it('reprocessar devolve o job à fila de origem e o tira da fila de mortos', async () => {
      const job = await fila.add('y', { comportamento: 'definitivo' });
      await esperar(async () => (await mortosDe(job.id!)).length === 1);
      const [morto] = await mortosDe(job.id!);
      execucoes.length = 0;

      const { jobId } = await filaDeMortos.reprocessar(morto.id!);

      expect(await mortos.getJob(morto.id!)).toBeUndefined();
      await esperar(() =>
        Promise.resolve(execucoes.some((e) => e.id === jobId)),
      );
      const listados = await filaDeMortos.listar({
        fila: MANUTENCAO_QUEUE,
        limite: 200,
      });
      expect(listados.some((m) => m.id === morto.id)).toBe(false);
    });

    it('jobId determinístico: o segundo enfileiramento da mesma chave não cria outro job', async () => {
      const opcoes = {
        jobId: 'webhook-evento-abc123',
        opcoes: { delay: 5_000 },
      };
      const a = await produtor.enfileirar(
        MANUTENCAO_QUEUE,
        'evento',
        { comportamento: 'ok' as const },
        opcoes,
      );
      const b = await produtor.enfileirar(
        MANUTENCAO_QUEUE,
        'evento',
        { comportamento: 'ok' as const },
        opcoes,
      );

      expect(b.id).toBe(a.id);
      expect((await fila.getJobCounts('delayed')).delayed).toBe(1);
    });
  },
);

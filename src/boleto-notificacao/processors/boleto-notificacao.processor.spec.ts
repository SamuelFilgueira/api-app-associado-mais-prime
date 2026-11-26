import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { ReguaIncompletaError } from 'src/boleto-notificacao/domain/regua-resultado';
import { BoletoNotificacaoProcessor } from 'src/boleto-notificacao/processors/boleto-notificacao.processor';
import { BoletoNotificacaoReceiptsService } from 'src/boleto-notificacao/services/boleto-notificacao-receipts.service';
import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { BOLETO_NOTIFICACAO_QUEUE } from 'src/queue/queue.module';

describe('BoletoNotificacaoProcessor', () => {
  const notificacao = { executarRotina: jest.fn() };
  const receipts = { verificarExecucao: jest.fn() };
  const produtor = { enfileirar: jest.fn() };
  let processor: BoletoNotificacaoProcessor;

  const job = (name: string, data: Record<string, unknown>) =>
    ({ id: '1', name, data, attemptsMade: 0 }) as unknown as Job<never>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    notificacao.executarRotina.mockResolvedValue([]);
    produtor.enfileirar.mockResolvedValue({ id: 'job-1' });
    processor = new BoletoNotificacaoProcessor(
      notificacao as unknown as BoletoNotificacaoService,
      receipts as unknown as BoletoNotificacaoReceiptsService,
      produtor as unknown as ProdutorDeFilas,
      { receber: jest.fn() } as unknown as FilaDeMortosService,
    );
  });

  afterAll(() => jest.restoreAllMocks());

  it('executar-rotina: delega ao service com os dados do job', async () => {
    await processor.process(
      job('executar-rotina', {
        origem: 'MANUAL',
        dataReferencia: '10/09/2026',
        tenants: ['MAIS_PRIME'],
        tipos: ['D0'],
        dryRun: true,
      }),
    );

    expect(notificacao.executarRotina).toHaveBeenCalledWith({
      origem: 'MANUAL',
      dataReferencia: new Date(2026, 8, 10),
      tenants: ['MAIS_PRIME'],
      tipos: ['D0'],
      dryRun: true,
    });
  });

  describe('verificar-receipts', () => {
    it('receipts pendentes: reagenda em 15 min com a base do job (retry e retenção: padrão da fila)', async () => {
      receipts.verificarExecucao.mockResolvedValue({ pendentes: 2 });

      await processor.process(
        job('verificar-receipts', {
          execucaoId: 5,
          tentativa: 1,
          baseOrigin: 'MAIS_PRIME_RS',
        }),
      );

      expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
      expect(produtor.enfileirar).toHaveBeenCalledWith(
        BOLETO_NOTIFICACAO_QUEUE,
        'verificar-receipts',
        { execucaoId: 5, tentativa: 2 },
        {
          base: 'MAIS_PRIME_RS',
          opcoes: {
            delay: 15 * 60_000,
            jobId: 'boleto-notificacao-receipts-5-2',
          },
        },
      );
    });

    it('job antigo, sem base no payload: reagenda sem base', async () => {
      receipts.verificarExecucao.mockResolvedValue({ pendentes: 1 });

      await processor.process(
        job('verificar-receipts', { execucaoId: 5, tentativa: 2 }),
      );

      expect(produtor.enfileirar.mock.calls[0][3]).toMatchObject({
        base: null,
        opcoes: { jobId: 'boleto-notificacao-receipts-5-3' },
      });
    });

    it('sem pendentes ou no limite de tentativas: não reagenda', async () => {
      receipts.verificarExecucao.mockResolvedValue({ pendentes: 0 });
      await processor.process(
        job('verificar-receipts', { execucaoId: 5, tentativa: 1 }),
      );

      receipts.verificarExecucao.mockResolvedValue({ pendentes: 3 });
      await processor.process(
        job('verificar-receipts', { execucaoId: 5, tentativa: 3 }),
      );

      expect(produtor.enfileirar).not.toHaveBeenCalled();
    });
  });

  describe('executar-rotina: quando a régua não fecha', () => {
    const resultado = (
      tenant: string,
      campos: Record<string, unknown> = {},
      pendentes = 0,
    ) => ({
      tenant,
      tipo: 'D0',
      dataReferencia: '10/09/2026',
      dataAlvo: '10/09/2026',
      status: 'CONCLUIDA',
      execucaoId: 1,
      metricas: { totalEnviados: 0, totalPendentes: pendentes },
      ...campos,
    });
    const jobComProgresso = (data: Record<string, unknown>) => {
      const j = job('executar-rotina', data) as unknown as {
        data: Record<string, unknown>;
        updateData: jest.Mock;
      };
      j.updateData = jest.fn((novo: Record<string, unknown>) => {
        j.data = novo;
        return Promise.resolve();
      });
      return j;
    };

    it('base em falha: o job LANÇA nomeando a base (a fila repete) e guarda as bases já concluídas', async () => {
      notificacao.executarRotina.mockResolvedValue([
        resultado('MAIS_PRIME', {
          status: 'FALHA',
          erro: 'SGA respondeu HTTP 403',
        }),
        resultado('MAIS_PRIME_RS'),
      ]);
      const j = jobComProgresso({
        origem: 'AGENDADA',
        dataReferencia: '10/09/2026',
      });

      const erro = await processor
        .process(j as unknown as Job<never>)
        .catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(ReguaIncompletaError);
      expect((erro as Error).message).toContain(
        'bases em falha: MAIS_PRIME (SGA respondeu HTTP 403)',
      );
      expect((erro as Error).message).not.toContain('MAIS_PRIME_RS');
      // Erro comum = transitório: o ProcessadorBase não o torna definitivo.
      expect(erro).not.toBeInstanceOf(UnrecoverableError);
      expect(j.updateData).toHaveBeenCalledWith({
        origem: 'AGENDADA',
        dataReferencia: '10/09/2026',
        progresso: {
          dataReferencia: '10/09/2026',
          basesConcluidas: ['MAIS_PRIME_RS'],
        },
      });
    });

    it('envio pendente (Expo sem resposta): também lança', async () => {
      notificacao.executarRotina.mockResolvedValue([
        resultado('MAIS_PRIME', {}, 3),
      ]);

      await expect(
        processor.process(
          jobComProgresso({ dataReferencia: '10/09/2026' }) as never,
        ),
      ).rejects.toThrow(/bases com envios pendentes: MAIS_PRIME \(3\)/);
    });

    it('retry: as bases que o job já concluiu para a data vão ao service e não são repetidas', async () => {
      notificacao.executarRotina.mockResolvedValue([
        resultado('MAIS_PRIME'),
        resultado('MAIS_PRIME_RS', {
          status: 'PULADA',
          motivoDoPulo: 'JA_CONCLUIDA',
        }),
      ]);
      const j = jobComProgresso({
        origem: 'MANUAL',
        dataReferencia: '10/09/2026',
        progresso: {
          dataReferencia: '10/09/2026',
          basesConcluidas: ['MAIS_PRIME_RS'],
        },
      });

      await expect(processor.process(j as never)).resolves.toHaveLength(2);

      expect(notificacao.executarRotina).toHaveBeenCalledWith({
        origem: 'MANUAL',
        dataReferencia: new Date(2026, 8, 10),
        tenants: undefined,
        tipos: undefined,
        dryRun: false,
        basesJaConcluidas: ['MAIS_PRIME_RS'],
      });
      expect(j.updateData).not.toHaveBeenCalled();
    });

    it('job agendado (sem data no payload): o progresso de hoje vale e fixa a data; o de outro dia é ignorado', async () => {
      jest.useFakeTimers().setSystemTime(new Date(2026, 8, 10, 11, 20));
      try {
        await processor.process(
          jobComProgresso({
            origem: 'AGENDADA',
            progresso: {
              dataReferencia: '10/09/2026',
              basesConcluidas: ['MAIS_PRIME_RS'],
            },
          }) as never,
        );
        expect(notificacao.executarRotina).toHaveBeenLastCalledWith(
          expect.objectContaining({
            dataReferencia: new Date(2026, 8, 10),
            basesJaConcluidas: ['MAIS_PRIME_RS'],
          }),
        );

        // Mesmo payload chegando num outro dia (progresso vazado/atrasado).
        jest.setSystemTime(new Date(2026, 8, 11, 11, 0));
        await processor.process(
          jobComProgresso({
            origem: 'AGENDADA',
            progresso: {
              dataReferencia: '10/09/2026',
              basesConcluidas: ['MAIS_PRIME_RS'],
            },
          }) as never,
        );
        expect(notificacao.executarRotina).toHaveBeenLastCalledWith({
          origem: 'AGENDADA',
          dataReferencia: undefined,
          tenants: undefined,
          tipos: undefined,
          dryRun: false,
          basesJaConcluidas: undefined,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('dry-run com base em falha: não lança (nada foi enviado), só relata', async () => {
      notificacao.executarRotina.mockResolvedValue([
        resultado('MAIS_PRIME', { status: 'FALHA', erro: 'SGA fora' }),
      ]);
      const j = jobComProgresso({ dryRun: true });

      await expect(processor.process(j as never)).resolves.toEqual([
        expect.objectContaining({ tenant: 'MAIS_PRIME', status: 'FALHA' }),
      ]);
      expect(j.updateData).not.toHaveBeenCalled();
    });

    it('base pulada por outra execução em curso: conclui sem lançar', async () => {
      notificacao.executarRotina.mockResolvedValue([
        resultado('MAIS_PRIME', {
          status: 'PULADA',
          motivoDoPulo: 'EXECUCAO_EM_CURSO',
          execucaoId: null,
        }),
      ]);

      await expect(
        processor.process(jobComProgresso({}) as never),
      ).resolves.toEqual([
        expect.objectContaining({ tenant: 'MAIS_PRIME', status: 'PULADA' }),
      ]);
    });

    it('data inválida no payload: erro definitivo, sem novas tentativas', async () => {
      await expect(
        processor.process(
          job('executar-rotina', { dataReferencia: '31/02/2026' }),
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(notificacao.executarRotina).not.toHaveBeenCalled();
    });
  });

  it('job desconhecido: ignora e conclui', async () => {
    await expect(processor.process(job('outro-job', {}))).resolves.toBeNull();
    expect(notificacao.executarRotina).not.toHaveBeenCalled();
    expect(receipts.verificarExecucao).not.toHaveBeenCalled();
  });
});

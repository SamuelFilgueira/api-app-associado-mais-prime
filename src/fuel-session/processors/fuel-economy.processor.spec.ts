import { Logger, NotFoundException } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import {
  FuelEconomyJobData,
  FuelEconomyProcessor,
} from 'src/fuel-session/processors/fuel-economy.processor';
import { VerificacaoDeEconomiaService } from 'src/fuel-session/services/verificacao-de-economia.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';

/**
 * O processor só delega a checagem e decide, quando o job morre, que a sessão
 * precisa ser expirada. A regra da checagem está no spec de
 * `VerificacaoDeEconomiaService`.
 */
describe('FuelEconomyProcessor', () => {
  const verificacao = {
    verificar: jest.fn(),
    expirarAposFalhaDoJob: jest.fn(),
  };
  const filaDeMortos = { receber: jest.fn() };
  let processor: FuelEconomyProcessor;
  const logs = {} as Record<'log' | 'warn' | 'error', jest.SpyInstance>;

  const job = (extra: Record<string, unknown> = {}) =>
    ({
      id: '1',
      name: 'check-fuel-economy',
      queueName: 'fuel-economy',
      data: { fuelSessionId: 'sessao-1', checagem: 1 },
      opts: { attempts: 3 },
      attemptsMade: 0,
      ...extra,
    }) as unknown as Job<FuelEconomyJobData>;

  const falha = (j: Job<FuelEconomyJobData>): Promise<unknown> =>
    processor.process(j).then(
      () => null,
      (e: unknown) => e,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    for (const nivel of ['log', 'warn', 'error'] as const) {
      logs[nivel] = jest
        .spyOn(Logger.prototype, nivel)
        .mockImplementation(() => undefined);
    }
    verificacao.expirarAposFalhaDoJob.mockResolvedValue('EXPIRADA');
    processor = new FuelEconomyProcessor(
      verificacao as unknown as VerificacaoDeEconomiaService,
      filaDeMortos as unknown as FilaDeMortosService,
    );
  });

  afterAll(() => jest.restoreAllMocks());

  describe('execução', () => {
    it('delega a checagem com o payload e as tentativas já feitas do job', async () => {
      const resultado = {
        processed: true,
        diferenca: 12.5,
        novoTotal: 112.5,
        push: 'enviado',
      };
      verificacao.verificar.mockResolvedValue(resultado);

      await expect(processor.process(job({ attemptsMade: 2 }))).resolves.toBe(
        resultado,
      );
      expect(verificacao.verificar).toHaveBeenCalledWith(
        { fuelSessionId: 'sessao-1', checagem: 1 },
        2,
      );
    });

    it('sem variação: o job CONCLUI (não falha, não gasta tentativa, não vai para a fila de mortos)', async () => {
      const resultado = {
        processed: false,
        reason: 'sem_variacao',
        checagem: 1,
        proximaChecagem: 2,
        atrasoMs: 60_000,
      };
      verificacao.verificar.mockResolvedValue(resultado);

      await expect(processor.process(job())).resolves.toBe(resultado);
      expect(verificacao.expirarAposFalhaDoJob).not.toHaveBeenCalled();
    });

    it('erro transitório (Clubgas fora): sai como erro comum e segue o retry da fila', async () => {
      verificacao.verificar.mockRejectedValue(new Error('ECONNRESET'));

      const erro = await falha(job());

      expect(erro).toBeInstanceOf(Error);
      expect(erro).not.toBeInstanceOf(UnrecoverableError);
    });

    it('erro definitivo (usuário sem CPF → 404): vira `UnrecoverableError`, sem novas tentativas', async () => {
      verificacao.verificar.mockRejectedValue(
        new NotFoundException('CPF não encontrado para o usuário'),
      );

      const erro = await falha(job());

      expect(erro).toBeInstanceOf(UnrecoverableError);
      expect((erro as Error).message).toBe('CPF não encontrado para o usuário');
    });
  });

  describe('onFailed — expiração da sessão quando o job morre', () => {
    it('tentativa intermediária com erro que será repetido: não expira', async () => {
      await processor.onFailed(job({ attemptsMade: 1 }), new Error('timeout'));

      expect(verificacao.expirarAposFalhaDoJob).not.toHaveBeenCalled();
    });

    it('tentativas esgotadas: expira a sessão', async () => {
      await processor.onFailed(job({ attemptsMade: 3 }), new Error('timeout'));

      expect(verificacao.expirarAposFalhaDoJob).toHaveBeenCalledWith(
        'sessao-1',
      );
    });

    it('erro definitivo na primeira tentativa: expira a sessão (o job não volta)', async () => {
      await processor.onFailed(
        job({ attemptsMade: 1 }),
        new UnrecoverableError('CPF não encontrado para o usuário'),
      );

      expect(verificacao.expirarAposFalhaDoJob).toHaveBeenCalledWith(
        'sessao-1',
      );
    });

    it('job antigo, com as opções de retry gravadas nele: vale o `attempts` do próprio job', async () => {
      const antigo = job({
        data: { fuelSessionId: 'sessao-antiga' },
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
        },
      });

      await processor.onFailed(
        { ...antigo, attemptsMade: 2 } as Job<FuelEconomyJobData>,
        new Error('timeout'),
      );
      expect(verificacao.expirarAposFalhaDoJob).not.toHaveBeenCalled();

      await processor.onFailed(
        { ...antigo, attemptsMade: 3 } as Job<FuelEconomyJobData>,
        new Error('timeout'),
      );
      expect(verificacao.expirarAposFalhaDoJob).toHaveBeenCalledWith(
        'sessao-antiga',
      );
    });

    it('a expiração falhou: o handler não lança e registra o resultado', async () => {
      verificacao.expirarAposFalhaDoJob.mockResolvedValue('FALHOU');

      await expect(
        processor.onFailed(job({ attemptsMade: 3 }), new Error('timeout')),
      ).resolves.toBeUndefined();
      expect(logs.warn).toHaveBeenCalledWith(
        expect.stringContaining('expiração: FALHOU'),
      );
    });

    it('evento sem job (já removido): nada a fazer', async () => {
      await expect(
        processor.onFailed(undefined, new Error('x')),
      ).resolves.toBeUndefined();
      expect(verificacao.expirarAposFalhaDoJob).not.toHaveBeenCalled();
    });
  });
});

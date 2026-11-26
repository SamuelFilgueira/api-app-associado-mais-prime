import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { JOURNEY_CLEANUP_JOB } from 'src/analytics/constants/analytics-journey.constants';
import {
  AnalyticsIngestProcessor,
  AnalyticsSummaryJobData,
} from 'src/analytics/processors/analytics-ingest.processor';
import { AnalyticsAplicarResumoService } from 'src/analytics/services/analytics-aplicar-resumo.service';
import { AnalyticsJornadaExpurgoService } from 'src/analytics/services/analytics-jornada-expurgo.service';
import { metricas } from 'src/infra/observability/metricas';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ANALYTICS_QUEUE } from 'src/queue/filas';
import { DomainError } from 'src/shared/erros/erros';

/** O processor só delega; a regra está no domínio e no repositório. */
describe('AnalyticsIngestProcessor', () => {
  const aplicarResumo = { aplicar: jest.fn() };
  const expurgo = { expurgarJornada: jest.fn() };
  let processor: AnalyticsIngestProcessor;
  let contador: jest.SpyInstance;
  const logs = {} as Record<'log' | 'warn' | 'error', jest.SpyInstance>;

  const dados = { payloadHash: 'p'.repeat(64) } as AnalyticsSummaryJobData;
  const job = (nome = 'process-summary') =>
    ({
      id: '7',
      name: nome,
      queueName: ANALYTICS_QUEUE,
      data: nome === 'process-summary' ? dados : {},
      opts: {},
      attemptsMade: 0,
    }) as unknown as Job<AnalyticsSummaryJobData>;

  const resultadosContados = () =>
    contador.mock.calls.map(
      ([rotulos]) => (rotulos as { resultado: string }).resultado,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    for (const nivel of ['log', 'warn', 'error'] as const) {
      logs[nivel] = jest
        .spyOn(Logger.prototype, nivel)
        .mockImplementation(() => undefined);
    }
    contador = jest.spyOn(metricas.filaProcessados, 'inc');
    processor = new AnalyticsIngestProcessor(
      aplicarResumo as unknown as AnalyticsAplicarResumoService,
      expurgo as unknown as AnalyticsJornadaExpurgoService,
      { receber: jest.fn() } as unknown as FilaDeMortosService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('summary aplicado: delega o payload do job e conclui como `aplicado`', async () => {
    aplicarResumo.aplicar.mockResolvedValue('APLICADO');

    await expect(processor.process(job())).resolves.toEqual({
      resultado: 'aplicado',
    });
    expect(aplicarResumo.aplicar).toHaveBeenCalledWith(dados);
    expect(resultadosContados()).toEqual(['ok']);
  });

  it('summary repetido: conclui (não falha) e conta `descartado` na métrica da fila', async () => {
    aplicarResumo.aplicar.mockResolvedValue('DESCARTADO');

    await expect(processor.process(job())).resolves.toEqual({
      resultado: 'descartado',
    });
    expect(contador).toHaveBeenCalledWith({
      queue: ANALYTICS_QUEUE,
      name: 'process-summary',
      resultado: 'descartado',
    });
    expect(resultadosContados()).not.toContain('falha');
  });

  it('falha ao aplicar (banco fora): registra e propaga, para o retry da fila', async () => {
    const falha = new Error("Can't reach database server");
    aplicarResumo.aplicar.mockRejectedValue(falha);

    await expect(processor.process(job())).rejects.toBe(falha);
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining('Falha ao processar analytics job 7'),
    );
    expect(resultadosContados()).toEqual(['falha']);
  });

  it('erro definitivo vira `UnrecoverableError` (sem novas tentativas)', async () => {
    aplicarResumo.aplicar.mockRejectedValue(
      new DomainError('X', 'payload impossível'),
    );

    await expect(processor.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('job de limpeza da jornada: delega ao serviço de expurgo, sem tocar na ingestão', async () => {
    const resultado = {
      removidos: 3,
      corte: new Date(),
      ttlDias: 90,
      incompleto: false,
    };
    expurgo.expurgarJornada.mockResolvedValue(resultado);

    await expect(processor.process(job(JOURNEY_CLEANUP_JOB))).resolves.toBe(
      resultado,
    );
    expect(aplicarResumo.aplicar).not.toHaveBeenCalled();
  });
});

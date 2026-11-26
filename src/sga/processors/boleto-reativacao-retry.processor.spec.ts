import { NotFoundException } from '@nestjs/common';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import {
  AGENDADOR_VARREDURA_RETRY,
  JOB_RETRY_BOLETO_REATIVACAO,
  JOB_VARRER_RETRY_BOLETO,
} from 'src/sga/config/boleto-reativacao-retry.config';
import { BoletoReativacaoRetryProcessor } from 'src/sga/processors/boleto-reativacao-retry.processor';
import { BoletoRetryVarreduraService } from 'src/sga/services/boleto-retry-varredura.service';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';

describe('BoletoReativacaoRetryProcessor', () => {
  let varredura: { executar: jest.Mock };
  let gerar: { processar: jest.Mock };
  let fila: { upsertJobScheduler: jest.Mock };
  let processor: BoletoReativacaoRetryProcessor;

  const job = (name: string, data: Record<string, unknown> = {}) =>
    ({ name, data, queueName: 'boleto-reativacao-retry' }) as Job<never>;

  beforeEach(() => {
    varredura = { executar: jest.fn().mockResolvedValue({ vencidas: 0 }) };
    gerar = {
      processar: jest
        .fn()
        .mockResolvedValue({ status: 'PENDENTE_RETRY', pulado: true }),
    };
    fila = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
    processor = new BoletoReativacaoRetryProcessor(
      varredura as unknown as BoletoRetryVarreduraService,
      gerar as unknown as GerarBoletoReativacaoService,
      fila as unknown as Queue,
      { receber: jest.fn() } as unknown as FilaDeMortosService,
    );
  });

  it('no boot garante UM agendador para a varredura (não um job por revistoria)', async () => {
    await processor.onApplicationBootstrap();

    expect(fila.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(fila.upsertJobScheduler).toHaveBeenCalledWith(
      AGENDADOR_VARREDURA_RETRY,
      { every: 60_000 },
      expect.objectContaining({
        name: JOB_VARRER_RETRY_BOLETO,
        opts: expect.objectContaining({ attempts: 1 }),
      }),
    );
  });

  it('falha ao agendar não derruba o boot', async () => {
    fila.upsertJobScheduler.mockRejectedValue(new Error('redis fora'));
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('job da varredura delega ao caso de uso', async () => {
    await processor.process(job(JOB_VARRER_RETRY_BOLETO));

    expect(varredura.executar).toHaveBeenCalledTimes(1);
    expect(gerar.processar).not.toHaveBeenCalled();
  });

  it('job atrasado antigo (payload antigo) ainda é atendido: uma tentativa de origem RETRY', async () => {
    await processor.process(
      job(JOB_RETRY_BOLETO_REATIVACAO, {
        reinspectionId: 10,
        debugId: 'dbg',
        baseOrigin: 'MAIS_PRIME',
      }),
    );

    expect(gerar.processar).toHaveBeenCalledWith(10, {
      origem: 'RETRY',
      debugId: 'dbg',
    });
    expect(varredura.executar).not.toHaveBeenCalled();
  });

  it('não engole o erro: a varredura que falha derruba o job', async () => {
    varredura.executar.mockRejectedValue(new Error('2 de 3 não concluíram'));

    await expect(
      processor.process(job(JOB_VARRER_RETRY_BOLETO)),
    ).rejects.toThrow('2 de 3 não concluíram');
  });

  it('revistoria inexistente num job antigo é erro definitivo (sem novas tentativas)', async () => {
    gerar.processar.mockRejectedValue(
      new NotFoundException('Revistoria não encontrada'),
    );

    await expect(
      processor.process(
        job(JOB_RETRY_BOLETO_REATIVACAO, { reinspectionId: 9 }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

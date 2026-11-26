import { Job, UnrecoverableError } from 'bullmq';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { OPCOES_POR_FILA, RETRY_PADRAO, WEBHOOK_QUEUE } from 'src/queue/filas';
import {
  CONCORRENCIA_DO_WEBHOOK,
  WebhookProcessor,
} from 'src/rastreamento/processors/webhook.processor';
import { EventoEmProcessamentoError } from 'src/rastreamento/services/processar-webhook-m7.service';
import { RastreamentoService } from 'src/rastreamento/services/rastreamento.service';
import { DomainError } from 'src/shared/erros/erros';

describe('WebhookProcessor', () => {
  const job = (payload: unknown) =>
    ({
      id: 'm7-abc',
      name: 'm7-event',
      queueName: WEBHOOK_QUEUE,
      data: { payload },
    }) as unknown as Job<{ payload: unknown }>;

  const criar = (processarWebhookM7: jest.Mock) =>
    new WebhookProcessor(
      { processarWebhookM7 } as unknown as RastreamentoService,
      { receber: jest.fn() } as unknown as FilaDeMortosService,
    );

  it('processa de 5 a 10 eventos ao mesmo tempo e a fila usa o retry padrão', () => {
    expect(CONCORRENCIA_DO_WEBHOOK).toBeGreaterThanOrEqual(5);
    expect(CONCORRENCIA_DO_WEBHOOK).toBeLessThanOrEqual(10);
    expect(OPCOES_POR_FILA[WEBHOOK_QUEUE]).toMatchObject(RETRY_PADRAO);
  });

  it('entrega o payload do job ao caso de uso e devolve o resultado', async () => {
    const processar = jest.fn().mockResolvedValue({ resultado: 'processado' });

    await expect(
      criar(processar).process(job({ chassi: 'X' })),
    ).resolves.toEqual({ resultado: 'processado' });
    expect(processar).toHaveBeenCalledWith({ chassi: 'X' });
  });

  it('erro de banco faz o job FALHAR (não é engolido) e continua valendo retry', async () => {
    const falha = Object.assign(new Error('pool esgotado'), { code: 'P2024' });

    await expect(
      criar(jest.fn().mockRejectedValue(falha)).process(job({})),
    ).rejects.toBe(falha);
  });

  it('evento em processamento por outra execução: falha transitória (tenta de novo)', async () => {
    const erro = new EventoEmProcessamentoError('a'.repeat(64));

    const lancado: unknown = await criar(jest.fn().mockRejectedValue(erro))
      .process(job({}))
      .catch((e: unknown) => e);

    expect(lancado).toBe(erro);
    expect(lancado).not.toBeInstanceOf(UnrecoverableError);
  });

  it('erro definitivo não gasta tentativas (vai para a fila de mortos)', async () => {
    const definitivo = new DomainError('X', 'regra violada');

    await expect(
      criar(jest.fn().mockRejectedValue(definitivo)).process(job({})),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

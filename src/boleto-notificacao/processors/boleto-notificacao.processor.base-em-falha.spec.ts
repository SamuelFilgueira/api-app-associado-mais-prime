/**
 * "Falha de consulta engolida": uma base com o SGA fora não impede as outras,
 * o JOB falha nomeando a base (para a fila repetir) e a repetição não
 * reenvia para quem já recebeu. Processor real + régua inteira; só SGA,
 * fila, trava e Expo são dublês.
 */
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { ehErroTransitorio, IntegrationError } from 'src/shared/erros/erros';
import { ReguaIncompletaError } from 'src/boleto-notificacao/domain/regua-resultado';
import { BoletoNotificacaoProcessor } from 'src/boleto-notificacao/processors/boleto-notificacao.processor';
import {
  boletoSga,
  consultaSga,
  montarRegua,
} from 'src/boleto-notificacao/testing/montar-regua';

jest.mock('src/config/tenant.config', () => ({
  TENANT: {
    baseNames: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
    defaultBase: 'MAIS_PRIME',
  },
  isTenantBase: (v: unknown) => v === 'MAIS_PRIME' || v === 'MAIS_PRIME_RS',
}));

/** Como o `SgaBoletoPeriodoClient` lança o 403 de extração da Hinova. */
const bloqueioDaHinova = () =>
  new IntegrationError({
    vendor: 'hinova',
    tipo: 'indisponivel',
    base: 'MAIS_PRIME',
    statusVendor: 403,
    message:
      'SGA /listar/boleto-associado/periodo respondeu HTTP 403 (página 3): {"mensagem":"Forbidden","error":["Token BLOQUEADO temporariamente por excesso de extracao de DADOS"]}',
  });

describe('BoletoNotificacaoProcessor — uma base em falha', () => {
  beforeEach(() => {
    for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  function cenario() {
    const montagem = montarRegua();
    const { prisma, sgaClient, service, receipts, produtor } = montagem;
    prisma.comUsuario('11111111111'); // MAIS_PRIME
    prisma.comUsuario('22222222222', { baseOrigin: 'MAIS_PRIME_RS' });
    prisma.comUsuario('33333333333', { baseOrigin: 'MAIS_PRIME_RS' });

    const boletosPorBase: Record<string, unknown[]> = {
      MAIS_PRIME: [boletoSga({ codigoAssociado: 1, cpf: '11111111111' })],
      MAIS_PRIME_RS: [
        boletoSga({ codigoAssociado: 2, cpf: '22222222222' }),
        boletoSga({
          nossoNumero: '3',
          codigoAssociado: 3,
          cpf: '33333333333',
          veiculos: [{ placa: 'RSX0X00' }],
        }),
      ],
    };
    let hinovaBloqueada = true;
    sgaClient.listarAbertosPorVencimento.mockImplementation((base: string) =>
      base === 'MAIS_PRIME' && hinovaBloqueada
        ? Promise.reject(bloqueioDaHinova())
        : Promise.resolve(consultaSga(boletosPorBase[base])),
    );

    const processor = new BoletoNotificacaoProcessor(
      service,
      receipts,
      produtor as never,
      { receber: jest.fn() } as unknown as FilaDeMortosService,
    );
    const criarJob = (data: Record<string, unknown>) => {
      const job = {
        id: '1',
        name: 'executar-rotina',
        queueName: 'boleto-notificacao',
        attemptsMade: 0,
        data,
        updateData: jest.fn((novo: Record<string, unknown>) => {
          job.data = novo;
          return Promise.resolve();
        }),
      };
      return job;
    };
    const basesVarridas = () =>
      sgaClient.listarAbertosPorVencimento.mock.calls.map(
        (c) => c[0] as string,
      );
    const pushesPara = () =>
      montagem.expo.sendPushNotificationsAsync.mock.calls.flatMap((c) =>
        (c[0] as Array<{ to: string }>).map((m) => m.to),
      );

    return {
      ...montagem,
      processor,
      criarJob,
      basesVarridas,
      pushesPara,
      liberarHinova: () => (hinovaBloqueada = false),
    };
  }

  const dadosDoJob = {
    origem: 'AGENDADA',
    dataReferencia: '10/09/2026',
    tipos: ['D0'],
  };

  it('a base bloqueada falha, a outra envia, e o job LANÇA nomeando a base em falha', async () => {
    const { processor, prisma, criarJob, basesVarridas, pushesPara } =
      cenario();
    const job = criarJob({ ...dadosDoJob });

    const erro = await processor
      .process(job as unknown as Job<never>)
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ReguaIncompletaError);
    expect((erro as Error).message).toMatch(
      /^Régua de boletos incompleta em 10\/09\/2026 — bases em falha: MAIS_PRIME \(SGA .* HTTP 403/,
    );
    expect((erro as Error).message).not.toContain('MAIS_PRIME_RS');
    expect(ehErroTransitorio(erro)).toBe(true); // a fila tenta de novo

    // A base fora não impediu a outra: os dois associados da RS receberam.
    expect(basesVarridas()).toEqual(['MAIS_PRIME', 'MAIS_PRIME_RS']);
    expect(pushesPara()).toEqual([
      prisma.usuarios[1].expoPushToken,
      prisma.usuarios[2].expoPushToken,
    ]);
    // A falha da consulta fica registrada como FALHA — não como "sem boletos".
    expect(
      prisma.execucoes.map((e) => [e.tenant, e.status, e.totalEnviados ?? 0]),
    ).toEqual([
      ['MAIS_PRIME', 'FALHA', 0],
      ['MAIS_PRIME_RS', 'CONCLUIDA', 2],
    ]);
    expect(prisma.execucoes[0].erro).toContain('HTTP 403');
    expect(job.data).toMatchObject({
      progresso: {
        dataReferencia: '10/09/2026',
        basesConcluidas: ['MAIS_PRIME_RS'],
      },
    });
  });

  it('retry do mesmo job: só a base que falhou é varrida de novo; quem já recebeu não recebe outra vez', async () => {
    const {
      processor,
      prisma,
      criarJob,
      basesVarridas,
      pushesPara,
      liberarHinova,
    } = cenario();
    const job = criarJob({ ...dadosDoJob });
    await processor
      .process(job as unknown as Job<never>)
      .catch(() => undefined);

    liberarHinova();
    job.attemptsMade = 1;
    const resumo = (await processor.process(
      job as unknown as Job<never>,
    )) as Array<{ tenant: string; status: string; enviados: number }>;

    expect(resumo.map((r) => [r.tenant, r.status, r.enviados])).toEqual([
      ['MAIS_PRIME', 'CONCLUIDA', 1],
      ['MAIS_PRIME_RS', 'PULADA', 0],
    ]);
    // 1ª tentativa: as duas bases; retry: só a MAIS_PRIME (cota da Hinova).
    expect(basesVarridas()).toEqual([
      'MAIS_PRIME',
      'MAIS_PRIME_RS',
      'MAIS_PRIME',
    ]);
    // Um push por associado no total: ninguém recebeu duas vezes.
    expect(pushesPara().sort()).toEqual(
      prisma.usuarios.map((u) => u.expoPushToken as string).sort(),
    );
    expect(prisma.logs.map((l) => l.statusEnvio)).toEqual([
      'ENVIADO',
      'ENVIADO',
      'ENVIADO',
    ]);
  });

  it('reexecução por um job NOVO (sem progresso): a base que deu certo é varrida de novo, mas a idempotência por log não reenvia', async () => {
    const { processor, prisma, criarJob, pushesPara, liberarHinova } =
      cenario();
    await processor
      .process(criarJob({ ...dadosDoJob }) as unknown as Job<never>)
      .catch(() => undefined);
    expect(pushesPara()).toHaveLength(2);

    liberarHinova();
    const resumo = (await processor.process(
      criarJob({ ...dadosDoJob, origem: 'MANUAL' }) as unknown as Job<never>,
    )) as Array<{ tenant: string; status: string; enviados: number }>;

    expect(resumo.map((r) => [r.tenant, r.status, r.enviados])).toEqual([
      ['MAIS_PRIME', 'CONCLUIDA', 1],
      ['MAIS_PRIME_RS', 'CONCLUIDA', 0],
    ]);
    expect(pushesPara()).toHaveLength(3);
    expect(new Set(pushesPara()).size).toBe(3);
    const ultima = prisma.execucoes[prisma.execucoes.length - 1];
    expect(ultima).toMatchObject({
      tenant: 'MAIS_PRIME_RS',
      status: 'CONCLUIDA',
      totalIdempotentes: 2,
      totalEnviados: 0,
    });
  });

  it('todas as bases em falha nas três tentativas: o job lança em todas e nada é enviado', async () => {
    const { processor, criarJob, pushesPara, sgaClient } = cenario();
    sgaClient.listarAbertosPorVencimento.mockRejectedValue(
      new Error('SGA fora do ar'),
    );
    const job = criarJob({ ...dadosDoJob });

    for (let tentativa = 0; tentativa < 3; tentativa++) {
      job.attemptsMade = tentativa;
      await expect(
        processor.process(job as unknown as Job<never>),
      ).rejects.toThrow(
        'bases em falha: MAIS_PRIME (SGA fora do ar); MAIS_PRIME_RS (SGA fora do ar)',
      );
    }
    expect(pushesPara()).toEqual([]);
    expect(job.data).toMatchObject({
      progresso: { dataReferencia: '10/09/2026', basesConcluidas: [] },
    });
  });
});

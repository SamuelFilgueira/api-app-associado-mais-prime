import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { TravaService } from 'src/infra/redis/trava.service';
import { DomainError } from 'src/shared/erros/erros';
import { chaveDaTrava } from 'src/boleto-notificacao/services/executar-regua.service';
import {
  boletoSga,
  consultaSga,
  montarRegua,
} from 'src/boleto-notificacao/testing/montar-regua';
import { PrismaDaReguaEmMemoria } from 'src/boleto-notificacao/testing/prisma-da-regua-em-memoria';
import { describeComRedis, limparChaves, redisDeTeste } from './ambiente';

jest.mock('src/config/tenant.config', () => ({
  TENANT: { baseNames: ['MAIS_PRIME'], defaultBase: 'MAIS_PRIME' },
  isTenantBase: () => true,
}));

/** Base fictícia por execução da suíte, para as chaves não se pisarem. */
const BASE = `IT_REGUA_${process.pid}`;
const DIA_10 = new Date(2026, 8, 10);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adiada<T>() {
  let resolver!: (valor: T) => void;
  const promessa = new Promise<T>((r) => (resolver = r));
  return { promessa, resolver };
}

/**
 * Régua de boletos com a `TravaService` de verdade (Redis real): dois
 * processos, cada um com a sua conexão, disputando a mesma base e data.
 * O banco é em memória e compartilhado pelos dois, como seria o MariaDB.
 */
describeComRedis('Redis real — uma execução da régua por base e dia', () => {
  let redisA: Redis;
  let redisB: Redis;

  beforeAll(() => {
    redisA = redisDeTeste();
    redisB = redisDeTeste();
  });

  afterAll(async () => {
    await limparChaves(redisA, `trava:boleto-regua:${BASE}`);
    await redisA.quit();
    await redisB.quit();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
    await limparChaves(redisA, `trava:boleto-regua:${BASE}`);
  });

  /** Dois "processos" sobre o mesmo banco, cada um com a sua trava/conexão. */
  function doisProcessos() {
    const prisma = new PrismaDaReguaEmMemoria();
    prisma.comUsuario('52998224725', { baseOrigin: BASE });
    const a = montarRegua({ prisma, trava: new TravaService(redisA) });
    const b = montarRegua({ prisma, trava: new TravaService(redisB) });
    return { prisma, a, b };
  }

  const opcoes = (dataReferencia = DIA_10) => ({
    dataReferencia,
    tenants: [BASE],
    tipos: ['D0' as const],
  });
  const chaveNoRedis = (dataReferencia = DIA_10) =>
    `trava:${chaveDaTrava(BASE, dataReferencia)}`;

  it('dois processos ao mesmo tempo na mesma base/data: UM varre o SGA e envia; o outro (rota manual) recebe 409', async () => {
    const { prisma, a, b } = doisProcessos();
    const varredura = adiada<ReturnType<typeof consultaSga>>();
    a.sgaClient.listarAbertosPorVencimento.mockReturnValue(varredura.promessa);
    b.sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );

    const agendada = a.service.executarRotina(opcoes());
    await dormir(50); // A já está com a trava, parada na varredura
    expect(await redisB.exists(chaveNoRedis())).toBe(1);

    const manual = await b.service
      .executarManual(opcoes())
      .catch((e: unknown) => e);

    expect(manual).toBeInstanceOf(DomainError);
    expect(manual).toMatchObject({ code: 'REGUA_EM_EXECUCAO', status: 409 });
    expect(b.sgaClient.listarAbertosPorVencimento).not.toHaveBeenCalled();

    varredura.resolver(consultaSga([boletoSga()]));
    const [resultado] = await agendada;

    expect(resultado).toMatchObject({ status: 'CONCLUIDA' });
    expect(resultado.metricas.totalEnviados).toBe(1);
    expect(a.expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(b.expo.sendPushNotificationsAsync).not.toHaveBeenCalled();
    expect(prisma.logs).toHaveLength(1);
    // Terminou: a trava foi solta.
    expect(await redisB.exists(chaveNoRedis())).toBe(0);
  });

  it('dois jobs disparados juntos (Promise.all): exatamente uma execução; o outro conclui como PULADA depois de esperar', async () => {
    const { prisma, a, b } = doisProcessos();
    for (const processo of [a, b]) {
      processo.aguardar.mockImplementation(() => dormir(20));
      processo.sgaClient.listarAbertosPorVencimento.mockImplementation(
        async () => {
          await dormir(400); // mais longo que toda a espera do outro job
          return consultaSga([boletoSga()]);
        },
      );
    }

    const [ra, rb] = await Promise.all([
      a.service.executarRotina(opcoes()),
      b.service.executarRotina(opcoes()),
    ]);

    expect([ra[0].status, rb[0].status].sort()).toEqual([
      'CONCLUIDA',
      'PULADA',
    ]);
    const pulada = ra[0].status === 'PULADA' ? ra[0] : rb[0];
    expect(pulada.motivoDoPulo).toBe('EXECUCAO_EM_CURSO');
    expect(
      a.sgaClient.listarAbertosPorVencimento.mock.calls.length +
        b.sgaClient.listarAbertosPorVencimento.mock.calls.length,
    ).toBe(1);
    expect(
      a.expo.sendPushNotificationsAsync.mock.calls.length +
        b.expo.sendPushNotificationsAsync.mock.calls.length,
    ).toBe(1);
    expect(prisma.logs).toHaveLength(1);
    expect(prisma.execucoes).toHaveLength(1);
  });

  it('trava deixada por um processo que morreu: o job espera ela expirar e roda (não conclui em branco)', async () => {
    const { a } = doisProcessos();
    a.sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );
    a.aguardar.mockImplementation(() => dormir(250));
    // Dono morto: a chave existe, ninguém renova, expira em 600 ms.
    await redisB.set(chaveNoRedis(), 'processo-morto', 'PX', 600);

    const [resultado] = await a.service.executarRotina(opcoes());

    expect(resultado.status).toBe('CONCLUIDA');
    expect(resultado.metricas.totalEnviados).toBe(1);
    expect(a.aguardar.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a mesma base em OUTRA data não é barrada', async () => {
    const { a, b } = doisProcessos();
    const varredura = adiada<ReturnType<typeof consultaSga>>();
    a.sgaClient.listarAbertosPorVencimento.mockReturnValue(varredura.promessa);
    b.sgaClient.listarAbertosPorVencimento.mockResolvedValue(consultaSga([]));

    const dia10 = a.service.executarRotina(opcoes());
    await dormir(50);
    const [dia11] = await b.service.executarManual(
      opcoes(new Date(2026, 8, 11)),
    );
    varredura.resolver(consultaSga([]));
    await dia10;

    expect(dia11.status).toBe('CONCLUIDA');
    expect(b.sgaClient.listarAbertosPorVencimento).toHaveBeenCalledTimes(1);
  });

  it('base que falha solta a trava: a repetição do job consegue rodar', async () => {
    const { a, b } = doisProcessos();
    a.sgaClient.listarAbertosPorVencimento.mockRejectedValue(
      new Error('SGA fora do ar'),
    );
    b.sgaClient.listarAbertosPorVencimento.mockResolvedValue(
      consultaSga([boletoSga()]),
    );

    const [falha] = await a.service.executarRotina(opcoes());
    expect(falha.status).toBe('FALHA');
    expect(await redisB.exists(chaveNoRedis())).toBe(0);

    const [retry] = await b.service.executarManual(opcoes());
    expect(retry.status).toBe('CONCLUIDA');
    expect(retry.metricas.totalEnviados).toBe(1);
  });
});

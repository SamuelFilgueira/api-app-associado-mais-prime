/**
 * Uma execução por base e dia, isolamento entre bases e o gauge da última
 * execução. Trava falsa em memória (a de verdade, com Redis, está em
 * `test/integracao/regua-trava.integration-spec.ts`).
 */
import { Logger } from '@nestjs/common';
import { resetAppConfig } from 'src/config/app.config';
import { metricas } from 'src/infra/observability/metricas';
import { DomainError, InfraError } from 'src/shared/erros/erros';
import { avaliarRegua } from 'src/boleto-notificacao/domain/regua-resultado';
import {
  chaveDaTrava,
  INTERVALO_DE_ESPERA_MS,
  TENTATIVAS_DE_TRAVA,
  TTL_DA_TRAVA_MS,
} from 'src/boleto-notificacao/services/executar-regua.service';
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

const DIA_10 = new Date(2026, 8, 10);
const CHAVE_MP = 'boleto-regua:MAIS_PRIME:2026-09-10';

async function gaugeDa(base: string): Promise<number | undefined> {
  const { values } = await metricas.boletoReguaUltimaExecucao.get();
  return values.find((v) => v.labels.base === base)?.value;
}

/** Promessa que o teste resolve quando quiser (segura a varredura do SGA). */
function adiada<T>() {
  let resolver!: (valor: T) => void;
  const promessa = new Promise<T>((r) => (resolver = r));
  return { promessa, resolver };
}

describe('ExecutarReguaService — trava, isolamento por base e gauge', () => {
  beforeEach(() => {
    metricas.boletoReguaUltimaExecucao.reset();
    for (const nivel of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('uma execução por base e dia', () => {
    it('a chave da trava é base + data de referência', () => {
      expect(chaveDaTrava('MAIS_PRIME', new Date(2026, 8, 10, 11, 0))).toBe(
        CHAVE_MP,
      );
      // A espera de quem aguarda cobre o TTL inteiro de uma trava sem dono.
      expect(
        (TENTATIVAS_DE_TRAVA - 1) * INTERVALO_DE_ESPERA_MS,
      ).toBeGreaterThan(TTL_DA_TRAVA_MS);
    });

    it('duas execuções simultâneas da mesma base/data: só uma varre o SGA e envia; a outra é pulada', async () => {
      const { service, prisma, sgaClient, expo, trava } = montarRegua();
      prisma.comUsuario('52998224725');
      const varredura = adiada<ReturnType<typeof consultaSga>>();
      sgaClient.listarAbertosPorVencimento.mockReturnValue(varredura.promessa);
      const opcoes = {
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME'],
        tipos: ['D0' as const],
      };

      const primeira = service.executarRotina(opcoes);
      const segunda = await service.executarRotina(opcoes); // a 1ª segura a trava
      varredura.resolver(consultaSga([boletoSga()]));
      const [resultado] = await primeira;

      expect(segunda).toHaveLength(1);
      expect(segunda[0]).toMatchObject({
        tenant: 'MAIS_PRIME',
        tipo: 'D0',
        status: 'PULADA',
        motivoDoPulo: 'EXECUCAO_EM_CURSO',
        execucaoId: null,
      });
      expect(resultado.status).toBe('CONCLUIDA');
      expect(sgaClient.listarAbertosPorVencimento).toHaveBeenCalledTimes(1);
      expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
      expect(prisma.execucoes).toHaveLength(1);
      expect(prisma.logs).toHaveLength(1);
      expect(new Set(trava.pedidos)).toEqual(new Set([CHAVE_MP]));
      // A que foi pulada não conta como falha: o job conclui sem repetir.
      expect(avaliarRegua(segunda).incompleta).toBe(false);
    });

    it('job: antes de desistir, espera o tempo de uma trava sem dono expirar', async () => {
      const { service, sgaClient, trava, aguardar } = montarRegua();
      trava.ocupadas.add(CHAVE_MP); // dono vivo: segue renovando

      const resultados = await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME'],
        tipos: ['D0'],
      });

      expect(resultados[0]).toMatchObject({
        status: 'PULADA',
        motivoDoPulo: 'EXECUCAO_EM_CURSO',
      });
      expect(trava.pedidos).toHaveLength(TENTATIVAS_DE_TRAVA);
      expect(aguardar).toHaveBeenCalledTimes(TENTATIVAS_DE_TRAVA - 1);
      expect(aguardar).toHaveBeenCalledWith(INTERVALO_DE_ESPERA_MS);
      expect(sgaClient.listarAbertosPorVencimento).not.toHaveBeenCalled();
    });

    it('job reexecutado depois de um restart: a trava do processo morto expira durante a espera e a régua roda', async () => {
      const { service, prisma, sgaClient, trava, aguardar } = montarRegua();
      prisma.comUsuario('52998224725');
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(
        consultaSga([boletoSga()]),
      );
      trava.ocupadas.add(CHAVE_MP); // trava órfã: ninguém renova
      aguardar.mockImplementation(() => {
        if (aguardar.mock.calls.length === 3) trava.ocupadas.delete(CHAVE_MP);
        return Promise.resolve();
      });

      const [resultado] = await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME'],
        tipos: ['D0'],
      });

      expect(resultado.status).toBe('CONCLUIDA');
      expect(resultado.metricas.totalEnviados).toBe(1);
      expect(aguardar).toHaveBeenCalledTimes(3);
    });

    it('rota manual: régua já em curso responde 409 REGUA_EM_EXECUCAO na hora, sem varrer o SGA', async () => {
      const { service, sgaClient, trava, aguardar } = montarRegua();
      trava.ocupadas.add(CHAVE_MP);

      const erro = await service
        .executarManual({
          dataReferencia: DIA_10,
          tenants: ['MAIS_PRIME'],
          dryRun: true,
        })
        .catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(DomainError);
      expect(erro).toMatchObject({
        code: 'REGUA_EM_EXECUCAO',
        status: 409,
        detalhes: { dataReferencia: '10/09/2026', bases: ['MAIS_PRIME'] },
      });
      expect(aguardar).not.toHaveBeenCalled();
      expect(trava.pedidos).toHaveLength(1);
      expect(sgaClient.listarAbertosPorVencimento).not.toHaveBeenCalled();
    });

    it('rota manual com uma base ocupada e outra livre: roda a livre e devolve a ocupada como PULADA', async () => {
      const { service, sgaClient, trava } = montarRegua();
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(consultaSga([]));
      trava.ocupadas.add(CHAVE_MP);

      const resultados = await service.executarManual({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
        tipos: ['D0'],
      });

      expect(resultados.map((r) => [r.tenant, r.status])).toEqual([
        ['MAIS_PRIME', 'PULADA'],
        ['MAIS_PRIME_RS', 'CONCLUIDA'],
      ]);
      expect(sgaClient.listarAbertosPorVencimento).toHaveBeenCalledTimes(1);
      expect(sgaClient.listarAbertosPorVencimento.mock.calls[0][0]).toBe(
        'MAIS_PRIME_RS',
      );
    });

    it('outra data ou outra base não disputam a mesma trava', async () => {
      const { service, sgaClient, trava } = montarRegua();
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(consultaSga([]));
      trava.ocupadas.add(CHAVE_MP);

      const resultados = await service.executarManual({
        dataReferencia: new Date(2026, 8, 11),
        tenants: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
        tipos: ['D0'],
      });

      expect(resultados.map((r) => r.status)).toEqual([
        'CONCLUIDA',
        'CONCLUIDA',
      ]);
      expect(trava.pedidos).toEqual([
        'boleto-regua:MAIS_PRIME:2026-09-11',
        'boleto-regua:MAIS_PRIME_RS:2026-09-11',
      ]);
    });

    it('a trava é solta ao fim, inclusive quando a base falha: a reexecução roda', async () => {
      const { service, sgaClient, trava } = montarRegua();
      sgaClient.listarAbertosPorVencimento
        .mockRejectedValueOnce(new Error('SGA fora do ar'))
        .mockResolvedValue(consultaSga([]));
      const opcoes = {
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME'],
        tipos: ['D0' as const],
      };

      const [falha] = await service.executarRotina(opcoes);
      expect(trava.ocupadas.size).toBe(0);
      const [ok] = await service.executarRotina(opcoes);

      expect([falha.status, ok.status]).toEqual(['FALHA', 'CONCLUIDA']);
    });

    it('dry-run também respeita a trava (não dispara uma segunda varredura do SGA)', async () => {
      const { service, sgaClient, trava } = montarRegua();
      trava.ocupadas.add(CHAVE_MP);

      await expect(
        service.executarManual({
          dataReferencia: DIA_10,
          tenants: ['MAIS_PRIME'],
          tipos: ['D0'],
          dryRun: true,
        }),
      ).rejects.toMatchObject({ code: 'REGUA_EM_EXECUCAO' });
      expect(sgaClient.listarAbertosPorVencimento).not.toHaveBeenCalled();
    });
  });

  describe('isolamento por base', () => {
    it('trava indisponível (Redis fora) numa base: ela sai como FALHA sem gravar execução, e a outra roda', async () => {
      const { service, prisma, sgaClient, trava } = montarRegua();
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(consultaSga([]));
      const tentar = trava.tentar.bind(trava);
      jest
        .spyOn(trava, 'tentar')
        .mockImplementation((chave: string, ttl: number, fn: never) =>
          chave === CHAVE_MP
            ? Promise.reject(new InfraError('redis'))
            : tentar(chave, ttl, fn),
        );

      const resultados = await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
        tipos: ['D0', 'D5'],
      });

      expect(
        resultados.map((r) => [r.tenant, r.tipo, r.status, r.execucaoId]),
      ).toEqual([
        ['MAIS_PRIME', 'D0', 'FALHA', null],
        ['MAIS_PRIME', 'D5', 'FALHA', null],
        ['MAIS_PRIME_RS', 'D0', 'CONCLUIDA', expect.any(Number)],
        ['MAIS_PRIME_RS', 'D5', 'CONCLUIDA', expect.any(Number)],
      ]);
      expect(resultados[0].erro).toContain('indisponível');
      expect(prisma.execucoes.map((e) => e.tenant)).toEqual([
        'MAIS_PRIME_RS',
        'MAIS_PRIME_RS',
      ]);
      expect(avaliarRegua(resultados).basesEmFalha.map((b) => b.base)).toEqual([
        'MAIS_PRIME',
      ]);
    });

    it('banco fora ao registrar a falha da consulta: a base sai como FALHA e a seguinte ainda roda', async () => {
      const { service, prisma, sgaClient } = montarRegua();
      sgaClient.listarAbertosPorVencimento
        .mockRejectedValueOnce(new Error('SGA fora do ar'))
        .mockResolvedValue(consultaSga([]));
      jest
        .spyOn(prisma.boletoNotificacaoExecucao, 'create')
        .mockRejectedValueOnce(new Error('banco fora'));

      const resultados = await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
        tipos: ['D0'],
      });

      expect(resultados.map((r) => [r.tenant, r.status, r.erro])).toEqual([
        ['MAIS_PRIME', 'FALHA', 'banco fora'],
        ['MAIS_PRIME_RS', 'CONCLUIDA', undefined],
      ]);
    });

    it('base já concluída por uma tentativa anterior do job: não varre o SGA de novo', async () => {
      const { service, sgaClient, trava } = montarRegua();
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(consultaSga([]));

      const resultados = await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
        tipos: ['D0'],
        basesJaConcluidas: ['MAIS_PRIME_RS'],
      });

      expect(
        resultados.map((r) => [r.tenant, r.status, r.motivoDoPulo]),
      ).toEqual([
        ['MAIS_PRIME', 'CONCLUIDA', undefined],
        ['MAIS_PRIME_RS', 'PULADA', 'JA_CONCLUIDA'],
      ]);
      expect(sgaClient.listarAbertosPorVencimento).toHaveBeenCalledTimes(1);
      expect(trava.pedidos).toEqual([CHAVE_MP]);
      expect(avaliarRegua(resultados).basesConcluidas).toEqual([
        'MAIS_PRIME',
        'MAIS_PRIME_RS',
      ]);
    });
  });

  describe('gauge boleto_regua_ultima_execucao_timestamp_seconds', () => {
    it('é gravado, em segundos, só para a base que concluiu', async () => {
      const { service, sgaClient } = montarRegua();
      sgaClient.listarAbertosPorVencimento
        .mockRejectedValueOnce(new Error('SGA fora do ar'))
        .mockResolvedValue(consultaSga([]));
      const antes = Math.floor(Date.now() / 1000);

      await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
      });

      expect(await gaugeDa('MAIS_PRIME')).toBeUndefined();
      const valor = (await gaugeDa('MAIS_PRIME_RS')) as number;
      expect(valor).toBeGreaterThanOrEqual(antes);
      expect(valor).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    });

    it('base que não é deste deploy (texto livre na rota manual) não vira série', async () => {
      const { service, sgaClient } = montarRegua();
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(consultaSga([]));

      const [resultado] = await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['BASE_DIGITADA_ERRADA'],
        tipos: ['D0'],
      });

      expect(resultado.status).toBe('CONCLUIDA');
      expect((await metricas.boletoReguaUltimaExecucao.get()).values).toEqual(
        [],
      );
    });

    it('dry-run, base pulada e etapa em falha não contam como execução', async () => {
      const { service, prisma, sgaClient, trava } = montarRegua();
      prisma.comUsuario('52998224725');
      sgaClient.listarAbertosPorVencimento.mockResolvedValue(
        consultaSga([boletoSga()]),
      );

      await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME'],
        dryRun: true,
      });
      expect(await gaugeDa('MAIS_PRIME')).toBeUndefined();

      trava.ocupadas.add(CHAVE_MP);
      await service
        .executarManual({ dataReferencia: DIA_10, tenants: ['MAIS_PRIME'] })
        .catch(() => undefined);
      trava.ocupadas.clear();
      expect(await gaugeDa('MAIS_PRIME')).toBeUndefined();

      jest
        .spyOn(prisma.user, 'findMany')
        .mockRejectedValueOnce(new Error('banco fora'));
      await service.executarRotina({
        dataReferencia: DIA_10,
        tenants: ['MAIS_PRIME'],
        tipos: ['D0'],
      });
      expect(await gaugeDa('MAIS_PRIME')).toBeUndefined();
    });

    describe('restauração no boot', () => {
      const papelOriginal = process.env.APP_ROLE;
      const definirPapel = (papel: string | undefined) => {
        if (papel === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = papel;
        resetAppConfig();
      };
      afterEach(() => definirPapel(papelOriginal));
      const LIGADA = { BOLETO_NOTIFICACAO_ENABLED: 'true' };

      async function comExecucoes(env: NodeJS.ProcessEnv = LIGADA) {
        const montagem = montarRegua({ env });
        const criar = (data: Record<string, unknown>) =>
          montagem.prisma.boletoNotificacaoExecucao.create({ data });
        await criar({
          tenant: 'MAIS_PRIME',
          status: 'CONCLUIDA',
          finalizadoEm: new Date('2026-09-09T14:05:00.000Z'),
        });
        await criar({
          tenant: 'MAIS_PRIME',
          status: 'CONCLUIDA',
          finalizadoEm: new Date('2026-09-10T14:07:30.900Z'),
        });
        // Mais recentes, mas não concluídas: não contam.
        await criar({
          tenant: 'MAIS_PRIME',
          status: 'FALHA',
          finalizadoEm: new Date('2026-09-11T14:00:00.000Z'),
        });
        await criar({ tenant: 'MAIS_PRIME', status: 'EM_ANDAMENTO' });
        // Base que só falhou e base fora deste deploy: sem série.
        await criar({
          tenant: 'MAIS_PRIME_RS',
          status: 'FALHA',
          finalizadoEm: new Date('2026-09-10T14:00:00.000Z'),
        });
        await criar({
          tenant: 'OUTRO_DEPLOY',
          status: 'CONCLUIDA',
          finalizadoEm: new Date('2026-09-10T14:00:00.000Z'),
        });
        return montagem;
      }

      it.each(['worker', undefined])(
        'papel %s: o gauge volta com a última execução CONCLUIDA de cada base, lida do banco',
        async (papel) => {
          definirPapel(papel);
          const { metrica } = await comExecucoes();

          await metrica.onApplicationBootstrap();

          expect(await gaugeDa('MAIS_PRIME')).toBe(
            Math.floor(Date.parse('2026-09-10T14:07:30.900Z') / 1000),
          );
          expect(await gaugeDa('MAIS_PRIME_RS')).toBeUndefined();
          expect(await gaugeDa('OUTRO_DEPLOY')).toBeUndefined();
        },
      );

      it.each(['api', 'pdf'])(
        'papel %s: não consulta o banco nem publica a série',
        async (papel) => {
          definirPapel(papel);
          const { metrica, prisma } = await comExecucoes();
          const groupBy = jest.spyOn(
            prisma.boletoNotificacaoExecucao,
            'groupBy',
          );

          await metrica.onApplicationBootstrap();

          expect(groupBy).not.toHaveBeenCalled();
          expect(await gaugeDa('MAIS_PRIME')).toBeUndefined();
        },
      );

      it('rotina desligada (BOLETO_NOTIFICACAO_ENABLED=false): não repõe a série — não há o que alertar', async () => {
        definirPapel('worker');
        const { metrica, prisma } = await comExecucoes({});
        const groupBy = jest.spyOn(prisma.boletoNotificacaoExecucao, 'groupBy');

        await metrica.onApplicationBootstrap();

        expect(groupBy).not.toHaveBeenCalled();
        expect(await gaugeDa('MAIS_PRIME')).toBeUndefined();
      });

      it('uma execução nova depois do boot passa na frente do valor restaurado', async () => {
        definirPapel('worker');
        const { metrica, service, sgaClient } = await comExecucoes();
        sgaClient.listarAbertosPorVencimento.mockResolvedValue(consultaSga([]));
        await metrica.onApplicationBootstrap();
        const restaurado = (await gaugeDa('MAIS_PRIME')) as number;

        await service.executarRotina({
          dataReferencia: DIA_10,
          tenants: ['MAIS_PRIME'],
        });

        expect(await gaugeDa('MAIS_PRIME')).toBeGreaterThan(restaurado);
      });
    });
  });
});

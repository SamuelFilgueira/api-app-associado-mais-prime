import { Prisma } from '@prisma/client';
import {
  DadosDoResumo,
  montarPlanoDeIngestao,
} from 'src/analytics/domain/agregados-diarios';
import { AnalyticsIngestaoRepository } from 'src/analytics/repositories/analytics-ingestao.repository';
import { AnalyticsAplicarResumoService } from 'src/analytics/services/analytics-aplicar-resumo.service';
import { PrismaService } from 'src/database/prisma.service';

const violacaoDeUnico = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'teste',
  });

const dados = (extra: Partial<DadosDoResumo> = {}): DadosDoResumo => ({
  sanitizedPayload: {
    period_start: '2026-07-01T15:00:00.000Z',
    period_end: '2026-07-01T15:30:00.000Z',
    platform: 'android',
    app_version: '2.1.0',
    runtime_version: '49.0.0',
    install_hash: 'i'.repeat(64),
    session_hash: 's'.repeat(64),
    screens: [
      { screen: 'screen_home', view_count: 2, total_time_ms: 5000 },
      { screen: 'screen_login', view_count: 1, total_time_ms: 1000 },
    ],
    actions: [{ action: 'auth_login_success', count: 1 }],
    forms: [
      {
        screen: 'screen_login',
        form: 'form_login',
        started_count: 1,
        submitted_count: 1,
        success_count: 1,
        error_count: 0,
      },
    ],
  },
  installHash: 'i'.repeat(64),
  sessionHash: 's'.repeat(64),
  payloadHash: 'p'.repeat(64),
  discardedItemsCount: 0,
  acceptedScreensCount: 2,
  acceptedActionsCount: 1,
  acceptedFormsCount: 1,
  analyticsUserId: null,
  ...extra,
});

/**
 * Transação de mentira que guarda só o necessário para a regra: os recibos
 * (por `payloadHash`) e os comandos de agregado emitidos.
 */
function bancoEmMemoria() {
  const recibos: Array<{ id: number; payloadHash: string }> = [];
  const comandos: Prisma.Sql[] = [];

  const tx = {
    analyticsSummaryReceipt: {
      findFirst: jest.fn(({ where }: { where: { payloadHash: string } }) =>
        Promise.resolve(
          recibos.find((r) => r.payloadHash === where.payloadHash) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: { payloadHash: string } }) => {
        const recibo = {
          id: recibos.length + 1,
          payloadHash: data.payloadHash,
        };
        recibos.push(recibo);
        return Promise.resolve({ id: recibo.id, receivedAt: new Date() });
      }),
    },
    analyticsDailyUniqueSession: { create: jest.fn().mockResolvedValue({}) },
    analyticsDailyUniqueInstall: { create: jest.fn().mockResolvedValue({}) },
    analyticsInstallFirstSeen: { create: jest.fn().mockResolvedValue({}) },
    analyticsDevice: { upsert: jest.fn() },
    analyticsUserDevice: { upsert: jest.fn(), updateMany: jest.fn() },
    analyticsJourneyEvent: { createMany: jest.fn() },
    $executeRaw: jest.fn((sql: Prisma.Sql) => {
      comandos.push(sql);
      return Promise.resolve(1);
    }),
  };
  const prisma = {
    // Como no banco: se a transação falha, o que ela gravou é desfeito.
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const recibosAntes = recibos.length;
      const comandosAntes = comandos.length;
      try {
        return await fn(tx);
      } catch (erro) {
        recibos.length = recibosAntes;
        comandos.length = comandosAntes;
        throw erro;
      }
    }),
  };

  return { tx, prisma, recibos, comandos };
}

describe('AnalyticsIngestaoRepository — aplicar()', () => {
  let banco: ReturnType<typeof bancoEmMemoria>;
  let repository: AnalyticsIngestaoRepository;

  const tabelaDe = (sql: Prisma.Sql) =>
    /INSERT INTO `(\w+)`/.exec(sql.sql)?.[1] ?? '(desconhecida)';

  beforeEach(() => {
    banco = bancoEmMemoria();
    repository = new AnalyticsIngestaoRepository(
      banco.prisma as unknown as PrismaService,
    );
  });

  describe('reenvio do mesmo summary', () => {
    it('mesmo payload duas vezes soma UMA vez: o segundo é descartado sem gravar nada', async () => {
      const aplicador = new AnalyticsAplicarResumoService(repository);

      await expect(aplicador.aplicar(dados())).resolves.toBe('APLICADO');
      const comandosDaPrimeira = banco.comandos.length;
      await expect(aplicador.aplicar(dados())).resolves.toBe('DESCARTADO');

      expect(banco.recibos).toHaveLength(1);
      expect(banco.comandos).toHaveLength(comandosDaPrimeira);
      expect(banco.tx.analyticsSummaryReceipt.create).toHaveBeenCalledTimes(1);
      expect(banco.tx.analyticsDailyUniqueSession.create).toHaveBeenCalledTimes(
        1,
      );
      expect(banco.tx.analyticsDailyUniqueInstall.create).toHaveBeenCalledTimes(
        1,
      );
    });

    it('a conferência do recibo é pelo `payloadHash` e acontece DENTRO da transação dos agregados', async () => {
      await repository.aplicar(montarPlanoDeIngestao(dados()));

      expect(banco.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(banco.tx.analyticsSummaryReceipt.findFirst).toHaveBeenCalledWith({
        where: { payloadHash: 'p'.repeat(64) },
        select: { id: true },
      });
      // Primeiro confere, depois grava.
      expect(
        banco.tx.analyticsSummaryReceipt.findFirst.mock.invocationCallOrder[0],
      ).toBeLessThan(
        banco.tx.analyticsSummaryReceipt.create.mock.invocationCallOrder[0],
      );
    });

    it('summary com outro `payloadHash` é aplicado normalmente', async () => {
      await repository.aplicar(montarPlanoDeIngestao(dados()));

      await expect(
        repository.aplicar(
          montarPlanoDeIngestao(dados({ payloadHash: 'q'.repeat(64) })),
        ),
      ).resolves.toBe('APLICADO');
      expect(banco.recibos).toHaveLength(2);
    });

    it('descarte também não grava jornada', async () => {
      const comJornada = dados({
        journey: { device: null, clientIp: null, events: [] },
      });
      banco.tx.analyticsDevice.upsert.mockResolvedValue({ lastUserId: null });

      await repository.aplicar(montarPlanoDeIngestao(comJornada));
      await repository.aplicar(montarPlanoDeIngestao(comJornada));

      expect(banco.tx.analyticsDevice.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('"já contabilizado" é só a violação de único (P2002)', () => {
    it('sessão já vista no dia (P2002): segue, somando só a instalação', async () => {
      banco.tx.analyticsDailyUniqueSession.create.mockRejectedValue(
        violacaoDeUnico(),
      );

      await expect(
        repository.aplicar(montarPlanoDeIngestao(dados())),
      ).resolves.toBe('APLICADO');

      const sessaoDiaria = banco.comandos.find(
        (c) => tabelaDe(c) === 'AnalyticsSessionDaily',
      );
      // (dia, plataforma, versão, sessionsCount, installsCount, criado, atualizado)
      expect(sessaoDiaria?.values.slice(3, 5)).toEqual([0, 1]);
    });

    it('instalação já vista no dia (P2002): não registra primeira aparição e soma só a sessão', async () => {
      banco.tx.analyticsDailyUniqueInstall.create.mockRejectedValue(
        violacaoDeUnico(),
      );

      await repository.aplicar(montarPlanoDeIngestao(dados()));

      expect(banco.tx.analyticsInstallFirstSeen.create).not.toHaveBeenCalled();
      const sessaoDiaria = banco.comandos.find(
        (c) => tabelaDe(c) === 'AnalyticsSessionDaily',
      );
      expect(sessaoDiaria?.values.slice(3, 5)).toEqual([1, 0]);
    });

    it('sessão e instalação já vistas (P2002 nas duas): a linha de sessões do dia não é tocada', async () => {
      banco.tx.analyticsDailyUniqueSession.create.mockRejectedValue(
        violacaoDeUnico(),
      );
      banco.tx.analyticsDailyUniqueInstall.create.mockRejectedValue(
        violacaoDeUnico(),
      );

      await repository.aplicar(montarPlanoDeIngestao(dados()));

      expect(banco.comandos.map(tabelaDe)).toEqual([
        'AnalyticsScreenDaily',
        'AnalyticsActionDaily',
        'AnalyticsFormDaily',
      ]);
    });

    it('aparelho já conhecido (P2002 na primeira aparição): segue', async () => {
      banco.tx.analyticsInstallFirstSeen.create.mockRejectedValue(
        violacaoDeUnico(),
      );

      await expect(
        repository.aplicar(montarPlanoDeIngestao(dados())),
      ).resolves.toBe('APLICADO');
    });

    it.each([
      ['sessão única', 'analyticsDailyUniqueSession'],
      ['instalação única', 'analyticsDailyUniqueInstall'],
      ['primeira aparição', 'analyticsInstallFirstSeen'],
    ] as const)(
      'qualquer outro erro em %s PROPAGA (antes um `catch {}` o engolia)',
      async (_caso, tabela) => {
        const falha = Object.assign(new Error("Can't reach database server"), {
          code: 'P1001',
        });
        banco.tx[tabela].create.mockRejectedValue(falha);

        await expect(
          repository.aplicar(montarPlanoDeIngestao(dados())),
        ).rejects.toBe(falha);
        // Nada de agregado depois do erro: a transação é desfeita inteira.
        expect(banco.comandos).toHaveLength(0);
      },
    );

    it('erro conhecido do Prisma que não é P2002 (ex.: valor longo demais, P2000) também propaga', async () => {
      const falha = new Prisma.PrismaClientKnownRequestError('value too long', {
        code: 'P2000',
        clientVersion: 'teste',
      });
      banco.tx.analyticsDailyUniqueSession.create.mockRejectedValue(falha);

      await expect(
        repository.aplicar(montarPlanoDeIngestao(dados())),
      ).rejects.toBe(falha);
    });

    it('objeto com `code: "P2002"` que não é erro do Prisma não é confundido com violação de único', async () => {
      const impostor = Object.assign(new Error('outro erro'), {
        code: 'P2002',
      });
      banco.tx.analyticsDailyUniqueInstall.create.mockRejectedValue(impostor);

      await expect(
        repository.aplicar(montarPlanoDeIngestao(dados())),
      ).rejects.toBe(impostor);
    });
  });

  describe('agregados em lote', () => {
    it('um comando por tabela de agregado, não importa quantas linhas', async () => {
      const telas = Array.from({ length: 30 }, (_, i) => ({
        screen: `screen_${String(i).padStart(2, '0')}`,
        view_count: i,
        total_time_ms: i * 10,
      }));
      const acoes = Array.from({ length: 40 }, (_, i) => ({
        action: `action_${String(i).padStart(2, '0')}`,
        count: i,
      }));

      await repository.aplicar(
        montarPlanoDeIngestao(
          dados({
            sanitizedPayload: {
              ...dados().sanitizedPayload,
              screens: telas,
              actions: acoes,
            },
          }),
        ),
      );

      expect(banco.comandos.map(tabelaDe)).toEqual([
        'AnalyticsSessionDaily',
        'AnalyticsScreenDaily',
        'AnalyticsActionDaily',
        'AnalyticsFormDaily',
      ]);
    });

    it('os valores vão como parâmetros, nunca dentro do texto do SQL', async () => {
      const malicioso = "screen_home'); DROP TABLE user; --";

      await repository.aplicar(
        montarPlanoDeIngestao(
          dados({
            sanitizedPayload: {
              ...dados().sanitizedPayload,
              platform: malicioso,
              app_version: malicioso.slice(0, 20),
              screens: [{ screen: malicioso, view_count: 1, total_time_ms: 1 }],
              actions: [{ action: malicioso, count: 1 }],
              forms: [
                {
                  screen: malicioso,
                  form: malicioso,
                  started_count: 1,
                  submitted_count: 1,
                  success_count: 1,
                  error_count: 1,
                },
              ],
            },
          }),
        ),
      );

      expect(banco.comandos).toHaveLength(4);
      for (const comando of banco.comandos) {
        expect(comando.sql).not.toContain('DROP TABLE');
        expect(comando.sql).not.toContain('screen_home');
        expect(comando.values).toContain(malicioso);
        // Um `?` por valor.
        expect(comando.sql.split('?').length - 1).toBe(comando.values.length);
      }
    });

    it('telas: 8 parâmetros por linha, com `ON DUPLICATE KEY UPDATE` somando', async () => {
      await repository.aplicar(montarPlanoDeIngestao(dados()));

      const telas = banco.comandos.find(
        (c) => tabelaDe(c) === 'AnalyticsScreenDaily',
      )!;
      const dia = new Date('2026-07-01T00:00:00.000Z');
      const agora = telas.values[6] as Date;

      expect(telas.values).toEqual([
        ...[dia, 'android', '2.1.0', 'screen_home', 2, 5000, agora, agora],
        ...[dia, 'android', '2.1.0', 'screen_login', 1, 1000, agora, agora],
      ]);
      expect(agora).toBeInstanceOf(Date);
      expect(telas.sql).toContain('ON DUPLICATE KEY UPDATE');
      expect(telas.sql).toContain(
        '`viewCount` = `viewCount` + VALUES(`viewCount`)',
      );
      expect(telas.sql).toContain(
        '`totalTimeMs` = `totalTimeMs` + VALUES(`totalTimeMs`)',
      );
    });

    it('summary sem telas, ações nem formulários: nenhum comando para essas tabelas', async () => {
      await repository.aplicar(
        montarPlanoDeIngestao(
          dados({
            sanitizedPayload: {
              ...dados().sanitizedPayload,
              screens: [],
              actions: [],
              forms: [],
            },
          }),
        ),
      );

      expect(banco.comandos.map(tabelaDe)).toEqual(['AnalyticsSessionDaily']);
    });
  });

  describe('conflito de escrita com outra transação', () => {
    it('deadlock / linha alterada desde a leitura: a transação inteira é repetida', async () => {
      const conflito = Object.assign(
        new Error('Record has changed since last read in table'),
        { code: 'P2034' },
      );
      banco.tx.$executeRaw.mockRejectedValueOnce(conflito);

      await expect(
        repository.aplicar(montarPlanoDeIngestao(dados())),
      ).resolves.toBe('APLICADO');
      expect(banco.prisma.$transaction).toHaveBeenCalledTimes(2);
      // A primeira tentativa foi desfeita: sobra UM recibo e um lote de comandos.
      expect(banco.recibos).toHaveLength(1);
      expect(banco.comandos.map(tabelaDe)).toEqual([
        'AnalyticsSessionDaily',
        'AnalyticsScreenDaily',
        'AnalyticsActionDaily',
        'AnalyticsFormDaily',
      ]);
    });
  });
});

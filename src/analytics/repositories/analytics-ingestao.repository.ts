import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ChaveDoDia,
  LinhaDeAcao,
  LinhaDeFormulario,
  LinhaDeTela,
  PlanoDaJornada,
  PlanoDeIngestao,
  incrementoDaSessaoDiaria,
} from 'src/analytics/domain/agregados-diarios';
import { comRetryEmConflito } from 'src/database/conflito-escrita.util';
import { PrismaService } from 'src/database/prisma.service';

type Transacao = Prisma.TransactionClient;

export type ResultadoDaIngestao =
  /** Agregados, recibo e jornada gravados. */
  | 'APLICADO'
  /** Já havia recibo com este `payloadHash`: nada foi gravado. */
  | 'DESCARTADO';

/** Vezes que a transação é tentada quando colide com outra escrita. */
const TENTATIVAS_EM_CONFLITO = 5;

function ehViolacaoDeUnico(erro: unknown): boolean {
  return (
    erro instanceof Prisma.PrismaClientKnownRequestError &&
    erro.code === 'P2002'
  );
}

/**
 * Grava o que a ingestão de um summary produz, numa única transação.
 *
 * Idempotência: o `payloadHash` do summary é conferido contra os recibos
 * DENTRO da transação que aplica os agregados. Reenvio do mesmo summary
 * (retry de rede do app, reentrega do job) encontra o recibo e não soma de
 * novo.
 */
@Injectable()
export class AnalyticsIngestaoRepository {
  constructor(private readonly prisma: PrismaService) {}

  aplicar(plano: PlanoDeIngestao): Promise<ResultadoDaIngestao> {
    // Conflito de escrita com outra transação (deadlock, linha de agregado
    // alterada desde a leitura) desfaz tudo; repetir a transação inteira é
    // seguro. Só aparece com mais de um worker gravando nas mesmas chaves; o
    // que sobrar depois destas tentativas segue o retry da fila.
    return comRetryEmConflito(
      () =>
        this.prisma.$transaction((tx) => this.aplicarNaTransacao(tx, plano)),
      TENTATIVAS_EM_CONFLITO,
    );
  }

  private async aplicarNaTransacao(
    tx: Transacao,
    plano: PlanoDeIngestao,
  ): Promise<ResultadoDaIngestao> {
    const { chave, installHash, sessionHash } = plano;
    const { dia: day, plataforma: platform, appVersion } = chave;

    // ── 0. Já aplicado? ──
    const jaAplicado = await tx.analyticsSummaryReceipt.findFirst({
      where: { payloadHash: plano.recibo.payloadHash },
      select: { id: true },
    });
    if (jaAplicado) return 'DESCARTADO';

    // ── 1. Recibo técnico ──
    const recibo = await tx.analyticsSummaryReceipt.create({
      data: plano.recibo,
      select: { id: true, receivedAt: true },
    });

    // ── 2. Sessão única no dia ──
    const sessaoNovaNoDia = await this.criarSeAindaNaoExiste(() =>
      tx.analyticsDailyUniqueSession.create({
        data: { day, platform, appVersion, sessionHash },
      }),
    );

    // ── 3. Instalação única no dia ──
    // A unicidade é (day, platform, installHash) — appVersion fica gravada
    // como dimensão (a primeira vista no dia), mas não gera nova contagem.
    const instalacaoNovaNoDia = await this.criarSeAindaNaoExiste(() =>
      tx.analyticsDailyUniqueInstall.create({
        data: { day, platform, appVersion, installHash },
      }),
    );

    // ── 3b. Primeira aparição do aparelho (base de "instalações novas") ──
    if (instalacaoNovaNoDia) {
      await this.criarSeAindaNaoExiste(() =>
        tx.analyticsInstallFirstSeen.create({
          data: { installHash, platform, appVersion, firstSeenDay: day },
        }),
      );
    }

    // ── 4 a 7. Agregados diários: um comando por tabela ──
    const agora = new Date();
    await this.somarSessaoDiaria(
      tx,
      chave,
      incrementoDaSessaoDiaria({ sessaoNovaNoDia, instalacaoNovaNoDia }),
      agora,
    );
    await this.somarTelas(tx, chave, plano.telas, agora);
    await this.somarAcoes(tx, chave, plano.acoes, agora);
    await this.somarFormularios(tx, chave, plano.formularios, agora);

    // ── 8. Jornada (aparelho, vínculo conta↔aparelho e eventos) ──
    if (plano.jornada) {
      await this.gravarJornada(tx, plano, plano.jornada, recibo);
    }

    return 'APLICADO';
  }

  /**
   * `INSERT` em tabela cuja chave única diz "já contabilizado". Devolve
   * `false` SÓ na violação de único (P2002); qualquer outro erro propaga —
   * antes um `catch {}` engolia tudo e a ingestão seguia com contagem errada.
   */
  private async criarSeAindaNaoExiste(
    criar: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await criar();
      return true;
    } catch (erro) {
      if (ehViolacaoDeUnico(erro)) return false;
      throw erro;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Agregados diários — `INSERT ... ON DUPLICATE KEY UPDATE` em lote.
  //
  // Um comando por tabela no lugar de um upsert por linha (cada upsert do
  // Prisma eram três idas ao banco). Os valores são sempre parâmetros
  // (`Prisma.sql`), nunca texto concatenado. `createdAt`/`updatedAt` vão
  // explícitos, em UTC, como o Prisma os gravava — o DEFAULT da coluna
  // usaria o fuso da sessão do banco.
  // ───────────────────────────────────────────────────────────────────────

  private async somarSessaoDiaria(
    tx: Transacao,
    chave: ChaveDoDia,
    incremento: { sessionsCount: number; installsCount: number } | null,
    agora: Date,
  ): Promise<void> {
    if (!incremento) return;

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO \`AnalyticsSessionDaily\`
        (\`day\`, \`platform\`, \`appVersion\`, \`sessionsCount\`, \`installsCount\`, \`createdAt\`, \`updatedAt\`)
      VALUES
        (${chave.dia}, ${chave.plataforma}, ${chave.appVersion}, ${incremento.sessionsCount}, ${incremento.installsCount}, ${agora}, ${agora})
      ON DUPLICATE KEY UPDATE
        \`sessionsCount\` = \`sessionsCount\` + VALUES(\`sessionsCount\`),
        \`installsCount\` = \`installsCount\` + VALUES(\`installsCount\`),
        \`updatedAt\` = VALUES(\`updatedAt\`)
    `);
  }

  private async somarTelas(
    tx: Transacao,
    chave: ChaveDoDia,
    linhas: LinhaDeTela[],
    agora: Date,
  ): Promise<void> {
    if (linhas.length === 0) return;

    const valores = linhas.map(
      (linha) =>
        Prisma.sql`(${chave.dia}, ${chave.plataforma}, ${chave.appVersion}, ${linha.screen}, ${linha.viewCount}, ${linha.totalTimeMs}, ${agora}, ${agora})`,
    );
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO \`AnalyticsScreenDaily\`
        (\`day\`, \`platform\`, \`appVersion\`, \`screen\`, \`viewCount\`, \`totalTimeMs\`, \`createdAt\`, \`updatedAt\`)
      VALUES ${Prisma.join(valores)}
      ON DUPLICATE KEY UPDATE
        \`viewCount\` = \`viewCount\` + VALUES(\`viewCount\`),
        \`totalTimeMs\` = \`totalTimeMs\` + VALUES(\`totalTimeMs\`),
        \`updatedAt\` = VALUES(\`updatedAt\`)
    `);
  }

  private async somarAcoes(
    tx: Transacao,
    chave: ChaveDoDia,
    linhas: LinhaDeAcao[],
    agora: Date,
  ): Promise<void> {
    if (linhas.length === 0) return;

    const valores = linhas.map(
      (linha) =>
        Prisma.sql`(${chave.dia}, ${chave.plataforma}, ${chave.appVersion}, ${linha.action}, ${linha.count}, ${agora}, ${agora})`,
    );
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO \`AnalyticsActionDaily\`
        (\`day\`, \`platform\`, \`appVersion\`, \`action\`, \`count\`, \`createdAt\`, \`updatedAt\`)
      VALUES ${Prisma.join(valores)}
      ON DUPLICATE KEY UPDATE
        \`count\` = \`count\` + VALUES(\`count\`),
        \`updatedAt\` = VALUES(\`updatedAt\`)
    `);
  }

  private async somarFormularios(
    tx: Transacao,
    chave: ChaveDoDia,
    linhas: LinhaDeFormulario[],
    agora: Date,
  ): Promise<void> {
    if (linhas.length === 0) return;

    const valores = linhas.map(
      (linha) =>
        Prisma.sql`(${chave.dia}, ${chave.plataforma}, ${chave.appVersion}, ${linha.screen}, ${linha.form}, ${linha.startedCount}, ${linha.submittedCount}, ${linha.successCount}, ${linha.errorCount}, ${agora}, ${agora})`,
    );
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO \`AnalyticsFormDaily\`
        (\`day\`, \`platform\`, \`appVersion\`, \`screen\`, \`form\`, \`startedCount\`, \`submittedCount\`, \`successCount\`, \`errorCount\`, \`createdAt\`, \`updatedAt\`)
      VALUES ${Prisma.join(valores)}
      ON DUPLICATE KEY UPDATE
        \`startedCount\` = \`startedCount\` + VALUES(\`startedCount\`),
        \`submittedCount\` = \`submittedCount\` + VALUES(\`submittedCount\`),
        \`successCount\` = \`successCount\` + VALUES(\`successCount\`),
        \`errorCount\` = \`errorCount\` + VALUES(\`errorCount\`),
        \`updatedAt\` = VALUES(\`updatedAt\`)
    `);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Jornada
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Na mesma transação do summary:
   *  1. AnalyticsDevice (upsert por installHash) — modelo/SO/último uso/IP;
   *  2. AnalyticsUserDevice (upsert por userId+installHash) — quando há JWT;
   *  3. AnalyticsJourneyEvent (createMany) — um INSERT para todos os eventos.
   */
  private async gravarJornada(
    tx: Transacao,
    plano: PlanoDeIngestao,
    jornada: PlanoDaJornada,
    recibo: { id: number; receivedAt: Date },
  ): Promise<void> {
    const { installHash, sessionHash, analyticsUserId, runtimeVersion } = plano;
    const { plataforma: platform, appVersion } = plano.chave;
    const { camposDoAparelho, loginEm, logoutEm } = jornada;

    // 1. Aparelho — campos do device só sobrescrevem quando vieram no payload
    //    (undefined faz o Prisma manter o valor atual).
    const aparelho = await tx.analyticsDevice.upsert({
      where: { installHash },
      create: {
        installHash,
        platform,
        appVersion,
        runtimeVersion: runtimeVersion ?? null,
        lastSessionHash: sessionHash,
        lastUserId: analyticsUserId,
        lastIp: jornada.clientIp,
        summariesCount: 1,
        firstSeenAt: recibo.receivedAt,
        lastSeenAt: recibo.receivedAt,
        ...camposDoAparelho,
      },
      update: {
        platform,
        appVersion,
        runtimeVersion: runtimeVersion ?? undefined,
        lastSessionHash: sessionHash,
        // Sem JWT não se sabe quem está logado; mantém o último usuário visto.
        lastUserId: analyticsUserId ?? undefined,
        lastIp: jornada.clientIp ?? undefined,
        summariesCount: { increment: 1 },
        lastSeenAt: recibo.receivedAt,
        ...camposDoAparelho,
      },
      select: { lastUserId: true },
    });

    // 2. Vínculo conta ↔ aparelho
    if (analyticsUserId !== null) {
      await tx.analyticsUserDevice.upsert({
        where: {
          userId_installHash: { userId: analyticsUserId, installHash },
        },
        create: {
          userId: analyticsUserId,
          installHash,
          platform,
          lastAppVersion: appVersion,
          lastSessionHash: sessionHash,
          summariesCount: 1,
          firstSeenAt: recibo.receivedAt,
          lastSeenAt: recibo.receivedAt,
          lastLoginAt: loginEm,
          lastLogoutAt: logoutEm,
        },
        update: {
          platform,
          lastAppVersion: appVersion,
          lastSessionHash: sessionHash,
          summariesCount: { increment: 1 },
          lastSeenAt: recibo.receivedAt,
          lastLoginAt: loginEm ?? undefined,
          lastLogoutAt: logoutEm ?? undefined,
        },
      });
    } else if (logoutEm && aparelho.lastUserId !== null) {
      // Flush pós-logout costuma chegar sem Authorization (token já apagado):
      // registra a saída no último vínculo conhecido deste aparelho.
      await tx.analyticsUserDevice.updateMany({
        where: { userId: aparelho.lastUserId, installHash },
        data: { lastLogoutAt: logoutEm },
      });
    }

    // 3. Eventos (um único INSERT)
    if (jornada.eventos.length > 0) {
      await tx.analyticsJourneyEvent.createMany({
        data: jornada.eventos.map((evento) => ({
          ...evento,
          receivedAt: recibo.receivedAt,
          receiptId: recibo.id,
          userId: analyticsUserId,
          installHash,
          sessionHash,
          platform,
          appVersion,
        })),
      });
    }
  }
}

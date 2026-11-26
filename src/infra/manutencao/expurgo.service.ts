import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import { join } from 'path';
import { appConfig } from 'src/config/app.config';
import { retencaoConfig } from 'src/config/retencao.config';
import { PrismaService } from 'src/database/prisma.service';
import { InfraError } from 'src/shared/erros/erros';

/** Linhas apagadas por comando: mantém a transação curta e o lock pequeno. */
const LOTE = 5_000;
/** Teto de lotes por tabela numa rodada (o resto fica para o dia seguinte). */
const MAX_LOTES = 200;
/** Arquivo de troca de PDF mais velho que isto ficou órfão. */
const PDF_ORFAO_APOS_MS = 15 * 60_000;

const DIA_MS = 86_400_000;

export type ResultadoDoExpurgo = Record<string, number>;

/** Expurgo de um módulo de domínio: devolve quantas linhas apagou. */
export type RotinaDeExpurgo = (agora: Date) => Promise<number>;

/**
 * Expurgos de retenção. Tudo em lotes (`DELETE ... LIMIT`), por data, sobre
 * coluna indexada — nunca um `DELETE` único numa tabela grande.
 *
 * O que é apagado e quando: `src/config/retencao.config.ts`.
 *
 * Módulo de domínio que tem expurgo próprio (regra dele, tabela dele)
 * registra a rotina com `registrarRotina` no boot: a manutenção a executa
 * na mesma rodada, sob a mesma trava — e esta pasta continua sem importar
 * módulo de domínio.
 */
@Injectable()
export class ExpurgoService {
  private readonly logger = new Logger(ExpurgoService.name);

  private readonly rotinasDosModulos = new Map<string, RotinaDeExpurgo>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inclui o expurgo de um módulo na rodada diária. Registrar de novo com o
   * mesmo nome substitui. O registro é do processo: chame no boot do papel
   * `worker`, que é onde a manutenção roda.
   */
  registrarRotina(nome: string, rotina: RotinaDeExpurgo): void {
    this.rotinasDosModulos.set(nome, rotina);
  }

  async executar(agora: Date = new Date()): Promise<ResultadoDoExpurgo> {
    const config = retencaoConfig();
    const antesDe = (d: number) => new Date(agora.getTime() - d * DIA_MS);
    const resultado: ResultadoDoExpurgo = {};

    const tarefas: Array<[string, number, (limite: Date) => Prisma.Sql]> = [
      [
        'Notification',
        config.notificacoesDias,
        (l) =>
          Prisma.sql`DELETE FROM Notification WHERE createdAt < ${l} LIMIT ${LOTE}`,
      ],
      [
        'VehicleWebhookEvent',
        config.webhookEventosDias,
        (l) =>
          Prisma.sql`DELETE FROM VehicleWebhookEvent WHERE receivedAt < ${l} LIMIT ${LOTE}`,
      ],
      [
        'AppVersionValidationLog',
        config.versaoLogDias,
        (l) =>
          Prisma.sql`DELETE FROM AppVersionValidationLog WHERE createdAt < ${l} LIMIT ${LOTE}`,
      ],
      [
        'AnalyticsSummaryReceipt',
        config.analyticsRecibosDias,
        (l) =>
          Prisma.sql`DELETE FROM AnalyticsSummaryReceipt WHERE receivedAt < ${l} LIMIT ${LOTE}`,
      ],
      [
        'OutboxEvento',
        config.outboxDias,
        (l) =>
          Prisma.sql`DELETE FROM OutboxEvento WHERE estado = 'PUBLICADO' AND publicadoEm < ${l} LIMIT ${LOTE}`,
      ],
      [
        'PushEntrega',
        config.pushEntregasDias,
        (l) =>
          Prisma.sql`DELETE e FROM PushEntrega e JOIN PushDisparo d ON d.id = e.disparoId WHERE d.estado IN ('CONCLUIDO', 'FALHOU') AND d.concluidoEm < ${l} LIMIT ${LOTE}`,
      ],
    ];

    for (const [tabela, diasDeRetencao, sql] of tarefas) {
      if (diasDeRetencao <= 0) continue;
      resultado[tabela] = await this.apagarEmLotes(
        tabela,
        sql(antesDe(diasDeRetencao)),
      );
    }

    // Disparos sem entregas restantes e já fora da retenção.
    if (config.pushEntregasDias > 0) {
      resultado.PushDisparo = await this.apagarEmLotes(
        'PushDisparo',
        Prisma.sql`DELETE FROM PushDisparo WHERE estado IN ('CONCLUIDO', 'FALHOU') AND concluidoEm < ${antesDe(config.pushEntregasDias)} AND NOT EXISTS (SELECT 1 FROM PushEntrega e WHERE e.disparoId = PushDisparo.id) LIMIT ${LOTE}`,
      );
    }

    // Chaves de idempotência vencidas: sempre.
    resultado.ChaveDeIdempotencia = await this.apagarEmLotes(
      'ChaveDeIdempotencia',
      Prisma.sql`DELETE FROM ChaveDeIdempotencia WHERE expiraEm < ${agora} LIMIT ${LOTE}`,
    );

    resultado.arquivosDePdf = await this.limparTrocaDePdf(agora);

    // Rotinas dos módulos: uma que falha não impede as outras, mas a rodada
    // termina em erro (o job vai para a fila de mortos e o alerta dispara).
    const falhas: string[] = [];
    for (const [nome, rotina] of this.rotinasDosModulos) {
      try {
        resultado[nome] = await rotina(agora);
      } catch (erro) {
        falhas.push(
          `${nome}: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }

    const resumo = Object.entries(resultado)
      .filter(([, total]) => total > 0)
      .map(([nome, total]) => `${nome}=${total}`)
      .join(' ');
    this.logger.log(
      `Expurgo concluído${resumo ? `: ${resumo}` : ' (nada a apagar)'}`,
    );
    if (falhas.length > 0) {
      throw new InfraError(
        'banco',
        `Expurgo incompleto — ${falhas.join('; ')}`,
      );
    }
    return resultado;
  }

  /** Remove HTML/PDF de pedidos de relatório que ninguém buscou. */
  async limparTrocaDePdf(agora: Date = new Date()): Promise<number> {
    const diretorio = appConfig().pdf.diretorioDeTroca;
    let nomes: string[];
    try {
      nomes = await fs.readdir(diretorio);
    } catch {
      return 0;
    }

    let removidos = 0;
    for (const nome of nomes) {
      if (!/^[0-9a-f-]{36}\.(html|pdf)$/i.test(nome)) continue;
      const caminho = join(diretorio, nome);
      try {
        const { mtimeMs } = await fs.stat(caminho);
        if (agora.getTime() - mtimeMs > PDF_ORFAO_APOS_MS) {
          await fs.unlink(caminho);
          removidos += 1;
        }
      } catch {
        // Outro processo removeu no meio: é o resultado esperado.
      }
    }
    return removidos;
  }

  private async apagarEmLotes(
    tabela: string,
    sql: Prisma.Sql,
  ): Promise<number> {
    let total = 0;
    for (let lote = 0; lote < MAX_LOTES; lote++) {
      const apagadas = await this.prisma.$executeRaw(sql);
      total += apagadas;
      if (apagadas < LOTE) return total;
      // Respiro entre lotes: o expurgo não deve disputar o banco com a API.
      await new Promise((resolver) => setTimeout(resolver, 200));
    }
    this.logger.warn(
      `Expurgo de ${tabela} parou no teto de ${MAX_LOTES} lotes (${total} linhas); o restante sai na próxima rodada.`,
    );
    return total;
  }
}

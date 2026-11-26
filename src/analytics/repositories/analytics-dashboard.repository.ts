import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  IntervaloDeConsulta,
  JanelasDaAudiencia,
  LinhasDaAudiencia,
} from 'src/analytics/domain/dashboard';
import { PrismaService } from 'src/database/prisma.service';

/** Recorte comum a todas as leituras: período e, se informados, plataforma e versão. */
export interface FiltroDoDashboard {
  intervalo: IntervaloDeConsulta;
  platform?: string;
  appVersion?: string;
}

/**
 * Leituras dos dashboards de analytics. Só `SELECT`, sempre sobre as tabelas
 * de agregado diário e as auxiliares de unicidade — nunca sobre os recibos.
 * Separado da ingestão: nada aqui grava.
 */
@Injectable()
export class AnalyticsDashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  private where(filtro: FiltroDoDashboard) {
    const where: Record<string, unknown> = {
      day: { gte: filtro.intervalo.from, lte: filtro.intervalo.to },
    };
    if (filtro.platform) where.platform = filtro.platform;
    if (filtro.appVersion) where.appVersion = filtro.appVersion;
    return where;
  }

  async somaDeSessoes(filtro: FiltroDoDashboard) {
    const { _sum } = await this.prisma.analyticsSessionDaily.aggregate({
      where: this.where(filtro),
      _sum: { sessionsCount: true, installsCount: true },
    });
    return _sum;
  }

  acoesPorDia(filtro: FiltroDoDashboard) {
    return this.prisma.analyticsActionDaily.findMany({
      where: this.where(filtro),
      select: { action: true, count: true },
    });
  }

  /**
   * Sem `take`: as linhas são diárias e qualquer corte de ranking precisa
   * acontecer DEPOIS da soma do período.
   */
  telasPorDia(filtro: FiltroDoDashboard) {
    return this.prisma.analyticsScreenDaily.findMany({
      where: this.where(filtro),
      select: { screen: true, viewCount: true, totalTimeMs: true },
    });
  }

  formulariosPorDia(filtro: FiltroDoDashboard) {
    return this.prisma.analyticsFormDaily.findMany({
      where: this.where(filtro),
      select: {
        screen: true,
        form: true,
        startedCount: true,
        submittedCount: true,
        successCount: true,
        errorCount: true,
      },
    });
  }

  sessoesPorDia(filtro: FiltroDoDashboard) {
    return this.prisma.analyticsSessionDaily.findMany({
      where: this.where(filtro),
      orderBy: { day: 'asc' },
      select: {
        day: true,
        platform: true,
        appVersion: true,
        sessionsCount: true,
        installsCount: true,
      },
    });
  }

  /**
   * Contagens de audiência por plataforma.
   *
   * Filtro por versão: aplicado sobre a versão registrada na PRIMEIRA
   * aparição do aparelho no dia. Aparelho que atualizou no meio do dia fica
   * na versão antiga até o dia seguinte.
   */
  async audiencia(
    janelas: JanelasDaAudiencia,
    filtro: Pick<FiltroDoDashboard, 'platform' | 'appVersion'>,
  ): Promise<LinhasDaAudiencia> {
    const { dayFrom, dayTo, wauFrom, mauFrom } = janelas;
    const platformSql = filtro.platform
      ? Prisma.sql`AND platform = ${filtro.platform}`
      : Prisma.empty;
    const versionSql = filtro.appVersion
      ? Prisma.sql`AND appVersion = ${filtro.appVersion}`
      : Prisma.empty;

    const [aparelhos, sessoes, novos, novosPorDia] = await Promise.all([
      this.prisma.$queryRaw<LinhasDaAudiencia['aparelhos'][number][]>(
        Prisma.sql`
        SELECT
          platform,
          COUNT(DISTINCT installHash) AS uniqueDevices,
          COUNT(*) AS deviceDays,
          COUNT(DISTINCT CASE WHEN day >= ${wauFrom} THEN installHash END) AS wau,
          COUNT(DISTINCT CASE WHEN day >= ${mauFrom} THEN installHash END) AS mau
        FROM \`AnalyticsDailyUniqueInstall\`
        WHERE day BETWEEN ${dayFrom} AND ${dayTo}
          ${platformSql} ${versionSql}
        GROUP BY platform
      `,
      ),
      this.prisma.$queryRaw<LinhasDaAudiencia['sessoes'][number][]>(
        Prisma.sql`
        SELECT platform, COUNT(DISTINCT sessionHash) AS uniqueSessions
        FROM \`AnalyticsDailyUniqueSession\`
        WHERE day BETWEEN ${dayFrom} AND ${dayTo}
          ${platformSql} ${versionSql}
        GROUP BY platform
      `,
      ),
      this.prisma.$queryRaw<LinhasDaAudiencia['novos'][number][]>(
        Prisma.sql`
        SELECT platform, COUNT(*) AS newDevices
        FROM \`AnalyticsInstallFirstSeen\`
        WHERE firstSeenDay BETWEEN ${dayFrom} AND ${dayTo}
          ${platformSql} ${versionSql}
        GROUP BY platform
      `,
      ),
      this.prisma.$queryRaw<LinhasDaAudiencia['novosPorDia'][number][]>(
        Prisma.sql`
        SELECT firstSeenDay AS day, platform, COUNT(*) AS count
        FROM \`AnalyticsInstallFirstSeen\`
        WHERE firstSeenDay BETWEEN ${dayFrom} AND ${dayTo}
          ${platformSql} ${versionSql}
        GROUP BY firstSeenDay, platform
        ORDER BY firstSeenDay ASC
      `,
      ),
    ]);

    return { aparelhos, sessoes, novos, novosPorDia };
  }
}

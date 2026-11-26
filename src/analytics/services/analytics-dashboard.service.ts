import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  IntervaloDeConsulta,
  MENSAGEM_DE_INTERVALO_INVALIDO,
  janelasDaAudiencia,
  montarAudiencia,
  montarOverview,
  rankingDeAcoes,
  rankingDeTelas,
  resolverIntervalo,
  resumoDeFormularios,
  serieDeSessoes,
  totalPorAcao,
} from 'src/analytics/domain/dashboard';
import { AnalyticsDashboardQueryDto } from 'src/analytics/dto/analytics-dashboard-query.dto';
import {
  AnalyticsDashboardRepository,
  FiltroDoDashboard,
} from 'src/analytics/repositories/analytics-dashboard.repository';

/**
 * Dashboards de analytics (`GET /analytics/dashboard/*`): somente leitura,
 * sobre os agregados diários. Separado da ingestão — nada aqui grava nem
 * enfileira.
 */
@Injectable()
export class AnalyticsDashboardService {
  constructor(private readonly leitura: AnalyticsDashboardRepository) {}

  private intervalo(query: AnalyticsDashboardQueryDto): IntervaloDeConsulta {
    const intervalo = resolverIntervalo(query, new Date());
    if (typeof intervalo === 'string') {
      throw new UnprocessableEntityException(
        MENSAGEM_DE_INTERVALO_INVALIDO[intervalo],
      );
    }
    return intervalo;
  }

  private filtro(query: AnalyticsDashboardQueryDto): FiltroDoDashboard {
    return {
      intervalo: this.intervalo(query),
      platform: query.platform,
      appVersion: query.app_version,
    };
  }

  /** Visão geral: totais de sessões, logins, ações principais e top telas. */
  async getDashboardOverview(query: AnalyticsDashboardQueryDto) {
    const filtro = this.filtro(query);
    const [sessoes, acoes, telas] = await Promise.all([
      this.leitura.somaDeSessoes(filtro),
      this.leitura.acoesPorDia(filtro),
      this.leitura.telasPorDia(filtro),
    ]);
    return montarOverview({ sessoes, acoes, telas });
  }

  /** Ranking de telas por visualizações e tempo total/médio. */
  async getDashboardScreens(query: AnalyticsDashboardQueryDto) {
    return rankingDeTelas(await this.leitura.telasPorDia(this.filtro(query)));
  }

  /** Contadores de ações por tipo. */
  async getDashboardActions(query: AnalyticsDashboardQueryDto) {
    return rankingDeAcoes(
      totalPorAcao(await this.leitura.acoesPorDia(this.filtro(query))),
    );
  }

  /** Métricas de formulários com taxas de sucesso/erro. */
  async getDashboardForms(query: AnalyticsDashboardQueryDto) {
    return resumoDeFormularios(
      await this.leitura.formulariosPorDia(this.filtro(query)),
    );
  }

  /** Série diária de sessões e instalações únicas. */
  async getDashboardSessions(query: AnalyticsDashboardQueryDto) {
    return serieDeSessoes(await this.leitura.sessoesPorDia(this.filtro(query)));
  }

  /**
   * Métricas de audiência para o painel administrativo (Insight Hub).
   *
   * Existe porque /sessions só devolve contagens já agregadas por dia — a
   * soma de `installsCount` é "aparelho-dia", não aparelhos únicos, e a
   * diferença chega a 3× num período de 30 dias. A semântica de cada número
   * está em `montarAudiencia`.
   */
  async getDashboardAudience(query: AnalyticsDashboardQueryDto) {
    const janelas = janelasDaAudiencia(this.intervalo(query));
    const linhas = await this.leitura.audiencia(janelas, {
      platform: query.platform,
      appVersion: query.app_version,
    });
    return montarAudiencia(janelas, linhas);
  }
}

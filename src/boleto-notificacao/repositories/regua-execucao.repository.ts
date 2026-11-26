import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { toUtcDateOnly } from 'src/shared/date.util';
import { MetricasMomento } from 'src/boleto-notificacao/domain/regua-resultado';
import { TipoMensagem } from 'src/boleto-notificacao/domain/regua-tipos';

export interface DadosDaExecucao {
  tenant: string;
  tipo: TipoMensagem;
  dataReferencia: Date;
  /** Fim da janela da etapa. */
  dataAlvo: Date;
  origem: 'AGENDADA' | 'MANUAL';
}

/** Só as métricas que têm coluna em `BoletoNotificacaoExecucao`. */
function metricasParaPersistir(m: MetricasMomento) {
  return {
    totalRegistrosSga: m.totalRegistrosSga,
    totalPaginasSga: m.totalPaginasSga,
    totalBoletosElegiveis: m.totalBoletosElegiveis,
    totalAssociados: m.totalAssociados,
    totalSemUsuario: m.totalSemUsuario,
    totalSemToken: m.totalSemToken,
    totalIdempotentes: m.totalIdempotentes,
    totalDuplicadosUsuario: m.totalDuplicadosUsuario,
    totalEnfileirados: m.totalEnfileirados,
    totalEnviados: m.totalEnviados,
    totalFalhas: m.totalFalhas,
    totalTokensInvalidos: m.totalTokensInvalidos,
    coberturaElegiveis: m.coberturaElegiveis,
  };
}

/**
 * `BoletoNotificacaoExecucao`: uma linha por base × etapa × rodada. O estado
 * só sai de `EM_ANDAMENTO` por aqui, com a condição no `WHERE`.
 */
@Injectable()
export class ReguaExecucaoRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Abre a execução da etapa (`EM_ANDAMENTO`). */
  async abrir(dados: DadosDaExecucao): Promise<number> {
    const execucao = await this.prisma.boletoNotificacaoExecucao.create({
      data: {
        tenant: dados.tenant,
        tipoMensagem: dados.tipo,
        dataReferencia: toUtcDateOnly(dados.dataReferencia),
        dataAlvo: toUtcDateOnly(dados.dataAlvo),
        status: 'EM_ANDAMENTO',
        origem: dados.origem,
        dryRun: false,
      },
      select: { id: true },
    });
    return execucao.id;
  }

  /** Etapa que nem começou: a consulta da base ao SGA falhou. */
  async registrarFalhaDeConsulta(
    dados: DadosDaExecucao,
    erro: string,
  ): Promise<number> {
    const execucao = await this.prisma.boletoNotificacaoExecucao.create({
      data: {
        tenant: dados.tenant,
        tipoMensagem: dados.tipo,
        dataReferencia: toUtcDateOnly(dados.dataReferencia),
        dataAlvo: toUtcDateOnly(dados.dataAlvo),
        status: 'FALHA',
        origem: dados.origem,
        erro: erro.slice(0, 2000),
        finalizadoEm: new Date(),
      },
      select: { id: true },
    });
    return execucao.id;
  }

  /** `EM_ANDAMENTO → CONCLUIDA`. `false` se a execução não estava aberta. */
  async concluir(id: number, metricas: MetricasMomento): Promise<boolean> {
    const { count } = await this.prisma.boletoNotificacaoExecucao.updateMany({
      where: { id, status: 'EM_ANDAMENTO' },
      data: {
        status: 'CONCLUIDA',
        finalizadoEm: new Date(),
        ...metricasParaPersistir(metricas),
      },
    });
    return count === 1;
  }

  /** `EM_ANDAMENTO → FALHA`. `false` se a execução não estava aberta. */
  async falhar(
    id: number,
    erro: string,
    metricas: MetricasMomento,
  ): Promise<boolean> {
    const { count } = await this.prisma.boletoNotificacaoExecucao.updateMany({
      where: { id, status: 'EM_ANDAMENTO' },
      data: {
        status: 'FALHA',
        erro: erro.slice(0, 2000),
        finalizadoEm: new Date(),
        ...metricasParaPersistir(metricas),
      },
    });
    return count === 1;
  }

  /** Instante da última execução `CONCLUIDA` de cada base. */
  async ultimaConclusaoPorBase(bases: string[]): Promise<Map<string, Date>> {
    if (bases.length === 0) return new Map();
    const grupos = await this.prisma.boletoNotificacaoExecucao.groupBy({
      by: ['tenant'],
      where: { tenant: { in: bases }, status: 'CONCLUIDA', dryRun: false },
      _max: { finalizadoEm: true },
    });
    const ultimas = new Map<string, Date>();
    for (const grupo of grupos) {
      if (grupo._max.finalizadoEm) {
        ultimas.set(grupo.tenant, grupo._max.finalizadoEm);
      }
    }
    return ultimas;
  }

  buscarParaRecibos(id: number) {
    return this.prisma.boletoNotificacaoExecucao.findUnique({
      where: { id },
      select: {
        id: true,
        tenant: true,
        tipoMensagem: true,
        totalEnfileirados: true,
      },
    });
  }

  /** Métricas de entrega recalculadas pela verificação de recibos. */
  async registrarEntrega(
    id: number,
    dados: {
      totalEntregues: number;
      totalFalhas: number;
      totalTokensInvalidos: number;
      coberturaEntrega: number | null;
    },
  ): Promise<void> {
    await this.prisma.boletoNotificacaoExecucao.update({
      where: { id },
      data: { ...dados, receiptsVerificadosEm: new Date() },
    });
  }
}

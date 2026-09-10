import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

/**
 * Consultas administrativas de execuções/logs da rotina de boletos.
 * Extraído do BoletoNotificacaoAdminController, que era o único controller
 * do projeto acessando o Prisma diretamente.
 */
@Injectable()
export class BoletoNotificacaoConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  listarExecucoes(tenant?: string, limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 30, 1), 200);
    return this.prisma.boletoNotificacaoExecucao.findMany({
      where: tenant ? { tenant } : undefined,
      orderBy: { iniciadoEm: 'desc' },
      take,
    });
  }

  buscarExecucao(id: number) {
    return this.prisma.boletoNotificacaoExecucao.findUnique({
      where: { id },
    });
  }

  contarLogsPorStatus(execucaoId: number) {
    return this.prisma.boletoNotificacaoLog.groupBy({
      by: ['statusEnvio'],
      where: { execucaoId },
      _count: { _all: true },
    });
  }

  listarLogs(execucaoId: number, status?: string, limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.prisma.boletoNotificacaoLog.findMany({
      where: {
        execucaoId,
        ...(status ? { statusEnvio: status as any } : {}),
      },
      orderBy: { id: 'asc' },
      take,
    });
  }
}

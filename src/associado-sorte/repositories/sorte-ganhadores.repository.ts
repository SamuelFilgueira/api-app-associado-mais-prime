import { Injectable } from '@nestjs/common';
import { Prisma, SorteGanhadorSituacao, SorteMecanica } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

export const ganhadorInclude = {
  premio: {
    select: {
      id: true,
      nome: true,
      descricao: true,
      imagemUrl: true,
      tipo: true,
      instrucoesRetirada: true,
    },
  },
  rodada: {
    select: { id: true, titulo: true, mecanica: true, abertura: true },
  },
  user: { select: { id: true, name: true, cpf: true } },
} satisfies Prisma.SorteGanhadorInclude;

export type GanhadorRecord = Prisma.SorteGanhadorGetPayload<{
  include: typeof ganhadorInclude;
}>;

/** Ganhadores e entrega (fora de transação). */
@Injectable()
export class SorteGanhadoresRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listarAdmin(params: {
    where: Prisma.SorteGanhadorWhereInput;
    skip: number;
    take: number;
  }): Promise<{ data: GanhadorRecord[]; total: number }> {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteGanhador.findMany({
        where: params.where,
        orderBy: { id: 'desc' },
        skip: params.skip,
        take: params.take,
        include: ganhadorInclude,
      }),
      this.prisma.sorteGanhador.count({ where: params.where }),
    ]);
    return { data, total };
  }

  buscar(id: number): Promise<GanhadorRecord | null> {
    return this.prisma.sorteGanhador.findUnique({
      where: { id },
      include: ganhadorInclude,
    });
  }

  buscarVarios(ids: number[]): Promise<GanhadorRecord[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.sorteGanhador.findMany({
      where: { id: { in: ids } },
      include: ganhadorInclude,
    });
  }

  listarDaRodada(rodadaId: number): Promise<GanhadorRecord[]> {
    return this.prisma.sorteGanhador.findMany({
      where: { rodadaId },
      orderBy: { id: 'asc' },
      include: ganhadorInclude,
    });
  }

  listarDoAssociado(userId: number): Promise<GanhadorRecord[]> {
    return this.prisma.sorteGanhador.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      include: ganhadorInclude,
    });
  }

  listarPendentesDoAssociado(userId: number): Promise<GanhadorRecord[]> {
    return this.prisma.sorteGanhador.findMany({
      where: {
        userId,
        situacao: {
          in: [
            SorteGanhadorSituacao.AGUARDANDO_CONTATO,
            SorteGanhadorSituacao.EM_CONTATO,
          ],
        },
      },
      orderBy: { id: 'desc' },
      include: ganhadorInclude,
    });
  }

  buscarDoAssociado(
    id: number,
    userId: number,
  ): Promise<GanhadorRecord | null> {
    return this.prisma.sorteGanhador.findFirst({
      where: { id, userId },
      include: ganhadorInclude,
    });
  }

  async confirmarContato(
    id: number,
    telefone: string,
    quando: Date,
  ): Promise<void> {
    await this.prisma.sorteGanhador.update({
      where: { id },
      data: { telefoneContato: telefone, telefoneConfirmadoEm: quando },
    });
  }

  /** Últimos ganhadores da base (lista pública do app). */
  listarUltimos(baseOrigin: string, limite: number): Promise<GanhadorRecord[]> {
    return this.prisma.sorteGanhador.findMany({
      where: {
        baseOrigin,
        situacao: { not: SorteGanhadorSituacao.CANCELADO },
      },
      orderBy: { id: 'desc' },
      take: limite,
      include: ganhadorInclude,
    });
  }

  /** Última vitória que conta para a carência (SORTEIO/CORRIDA, não cancelada). */
  async ultimaVitoriaComCarencia(
    userId: number,
    desde: Date,
  ): Promise<Date | null> {
    const g = await this.prisma.sorteGanhador.findFirst({
      where: {
        userId,
        origem: { in: [SorteMecanica.SORTEIO, SorteMecanica.CORRIDA] },
        situacao: { not: SorteGanhadorSituacao.CANCELADO },
        createdAt: { gt: desde },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return g?.createdAt ?? null;
  }

  contarAguardandoContato(baseOrigin: string): Promise<number> {
    return this.prisma.sorteGanhador.count({
      where: { baseOrigin, situacao: SorteGanhadorSituacao.AGUARDANDO_CONTATO },
    });
  }

  listarAguardandoContato(
    baseOrigin: string,
    limite: number,
  ): Promise<GanhadorRecord[]> {
    return this.prisma.sorteGanhador.findMany({
      where: { baseOrigin, situacao: SorteGanhadorSituacao.AGUARDANDO_CONTATO },
      orderBy: { id: 'asc' },
      take: limite,
      include: ganhadorInclude,
    });
  }

  /** Compras de cada produto pelo associado (não canceladas), para a loja. */
  async comprasPorProduto(userId: number): Promise<Map<number, number>> {
    const grupos = await this.prisma.sorteGanhador.groupBy({
      by: ['premioId'],
      where: {
        userId,
        origem: 'LOJA',
        situacao: { not: SorteGanhadorSituacao.CANCELADO },
      },
      _count: { _all: true },
    });
    return new Map(grupos.map((g) => [g.premioId, g._count._all]));
  }

  /** Dados do e-mail de retirada (nome e CPF só para mascarar). */
  buscarParaEmail(id: number) {
    return this.prisma.sorteGanhador.findUnique({
      where: { id },
      select: {
        id: true,
        codigo: true,
        baseOrigin: true,
        creditosGastos: true,
        telefoneContato: true,
        createdAt: true,
        premio: { select: { nome: true, tipo: true } },
        user: { select: { name: true, cpf: true } },
      },
    });
  }

  /** Token de push dos ganhadores (leitura da tabela `user`). */
  async listarParaPush(ids: number[]) {
    return this.prisma.sorteGanhador.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        userId: true,
        baseOrigin: true,
        origem: true,
        premio: { select: { nome: true } },
        user: { select: { expoPushToken: true } },
      },
    });
  }
}

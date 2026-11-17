import { Injectable } from '@nestjs/common';
import {
  Prisma,
  SorteEstoqueMovimento,
  SortePremio,
  SorteRodadaEstado,
} from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

/** Prêmios e histórico de estoque (leituras e escritas simples). */
@Injectable()
export class SortePremiosRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listar(params: {
    where: Prisma.SortePremioWhereInput;
    skip: number;
    take: number;
  }): Promise<{ data: SortePremio[]; total: number }> {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sortePremio.findMany({
        where: params.where,
        orderBy: [{ ativo: 'desc' }, { ordem: 'asc' }, { nome: 'asc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.sortePremio.count({ where: params.where }),
    ]);
    return { data, total };
  }

  buscar(id: number): Promise<SortePremio | null> {
    return this.prisma.sortePremio.findFirst({
      where: { id, deletedAt: null },
    });
  }

  criar(data: Prisma.SortePremioCreateInput): Promise<SortePremio> {
    return this.prisma.sortePremio.create({ data });
  }

  atualizar(
    id: number,
    data: Prisma.SortePremioUpdateInput,
  ): Promise<SortePremio> {
    return this.prisma.sortePremio.update({ where: { id }, data });
  }

  async excluirLogico(id: number): Promise<void> {
    await this.prisma.sortePremio.update({
      where: { id },
      data: { ativo: false, deletedAt: new Date() },
    });
  }

  /** Rodadas que ainda prendem o prêmio (impedem a exclusão). */
  contarRodadasVivas(premioId: number): Promise<number> {
    return this.prisma.sorteRodada.count({
      where: {
        premioId,
        estado: {
          in: [SorteRodadaEstado.PUBLICADA, SorteRodadaEstado.APURANDO],
        },
      },
    });
  }

  /** Unidades comprometidas em rodadas publicadas, por prêmio. */
  async reservadoPorPremio(premioIds: number[]): Promise<Map<number, number>> {
    const mapa = new Map<number, number>();
    if (premioIds.length === 0) return mapa;
    const grupos = await this.prisma.sorteRodada.groupBy({
      by: ['premioId'],
      where: {
        premioId: { in: premioIds },
        estado: {
          in: [SorteRodadaEstado.PUBLICADA, SorteRodadaEstado.APURANDO],
        },
      },
      _sum: { quantidadeRestante: true },
    });
    for (const g of grupos) {
      mapa.set(g.premioId, g._sum.quantidadeRestante ?? 0);
    }
    return mapa;
  }

  async listarMovimentos(params: {
    premioId: number;
    skip: number;
    take: number;
  }): Promise<{ data: SorteEstoqueMovimento[]; total: number }> {
    const where = { premioId: params.premioId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteEstoqueMovimento.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.sorteEstoqueMovimento.count({ where }),
    ]);
    return { data, total };
  }

  /** Vitrine da Loja da Sorte: na loja, ativos e não excluídos. */
  listarLoja(): Promise<SortePremio[]> {
    return this.prisma.sortePremio.findMany({
      where: { naLoja: true, ativo: true, deletedAt: null },
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
    });
  }

  listarEstoqueBaixo(limite: number): Promise<SortePremio[]> {
    return this.prisma.sortePremio.findMany({
      where: { deletedAt: null, ativo: true, estoque: { lte: limite } },
      orderBy: [{ estoque: 'asc' }, { nome: 'asc' }],
      take: 20,
    });
  }
}

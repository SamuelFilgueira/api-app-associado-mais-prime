import { Injectable } from '@nestjs/common';
import { Prisma, SorteInscricao, SorteInscricaoFonte } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

export type InscricaoComUsuario = SorteInscricao & {
  user: { id: number; name: string; cpf: string; isActive: boolean };
};

/** Cache da inscrição no produto do SGA (um associado = um participante). */
@Injectable()
export class SorteInscricoesRepository {
  constructor(private readonly prisma: PrismaService) {}

  buscar(userId: number): Promise<SorteInscricao | null> {
    return this.prisma.sorteInscricao.findUnique({ where: { userId } });
  }

  buscarVarias(userIds: number[]): Promise<SorteInscricao[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.prisma.sorteInscricao.findMany({
      where: { userId: { in: userIds } },
    });
  }

  salvar(
    userId: number,
    data: {
      baseOrigin: string;
      inscrito: boolean;
      fonte: SorteInscricaoFonte;
      codigoVeiculo?: string | null;
      verificadoEm?: Date | null;
      autorId?: number | null;
      autorNome?: string | null;
      motivo?: string | null;
    },
  ): Promise<SorteInscricao> {
    return this.prisma.sorteInscricao.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  /** Grava o resultado do SGA sem passar por cima de uma marcação manual. */
  async salvarDoSga(
    userId: number,
    data: {
      baseOrigin: string;
      inscrito: boolean;
      codigoVeiculo: string | null;
      verificadoEm: Date;
    },
  ): Promise<void> {
    await this.prisma.sorteInscricao.createMany({
      data: [{ userId, fonte: SorteInscricaoFonte.SGA, ...data }],
      skipDuplicates: true,
    });
    await this.prisma.sorteInscricao.updateMany({
      where: { userId, fonte: SorteInscricaoFonte.SGA },
      data,
    });
  }

  async remover(userId: number): Promise<void> {
    await this.prisma.sorteInscricao.deleteMany({ where: { userId } });
  }

  async listar(params: {
    where: Prisma.SorteInscricaoWhereInput;
    skip: number;
    take: number;
  }): Promise<{ data: InscricaoComUsuario[]; total: number }> {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteInscricao.findMany({
        where: params.where,
        orderBy: { updatedAt: 'desc' },
        skip: params.skip,
        take: params.take,
        include: {
          user: {
            select: { id: true, name: true, cpf: true, isActive: true },
          },
        },
      }),
      this.prisma.sorteInscricao.count({ where: params.where }),
    ]);
    return { data, total };
  }

  contarInscritos(baseOrigin: string): Promise<number> {
    return this.prisma.sorteInscricao.count({
      where: { baseOrigin, inscrito: true },
    });
  }

  buscarUsuario(userId: number) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, cpf: true, baseOrigin: true, name: true },
    });
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma, SorteNotificacaoAdmin, SorteTentativa } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

/** Notificações do painel e registro de tentativas que falharam. */
@Injectable()
export class SorteNotificacoesAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listar(params: {
    where: Prisma.SorteNotificacaoAdminWhereInput;
    skip: number;
    take: number;
  }): Promise<{ data: SorteNotificacaoAdmin[]; total: number }> {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteNotificacaoAdmin.findMany({
        where: params.where,
        orderBy: { id: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.sorteNotificacaoAdmin.count({ where: params.where }),
    ]);
    return { data, total };
  }

  buscar(id: number): Promise<SorteNotificacaoAdmin | null> {
    return this.prisma.sorteNotificacaoAdmin.findUnique({ where: { id } });
  }

  contarNaoLidas(baseOrigin?: string): Promise<number> {
    return this.prisma.sorteNotificacaoAdmin.count({
      where: { lidaEm: null, ...(baseOrigin ? { baseOrigin } : {}) },
    });
  }

  async marcarLida(
    id: number,
    quando: Date,
    autor: { id: number | null; nome: string | null },
  ): Promise<void> {
    await this.prisma.sorteNotificacaoAdmin.updateMany({
      where: { id, lidaEm: null },
      data: { lidaEm: quando, lidaPorId: autor.id, lidaPorNome: autor.nome },
    });
  }

  async marcarTodas(
    quando: Date,
    autor: { id: number | null; nome: string | null },
    baseOrigin?: string,
  ): Promise<number> {
    const r = await this.prisma.sorteNotificacaoAdmin.updateMany({
      where: { lidaEm: null, ...(baseOrigin ? { baseOrigin } : {}) },
      data: { lidaEm: quando, lidaPorId: autor.id, lidaPorNome: autor.nome },
    });
    return r.count;
  }

  async registrarEmail(
    id: number,
    data: { emailEnviadoEm?: Date | null; emailErro?: string | null },
  ): Promise<void> {
    await this.prisma.sorteNotificacaoAdmin.update({ where: { id }, data });
  }

  // -------------------------------------------------------------- tentativas

  async criarTentativa(
    data: Prisma.SorteTentativaUncheckedCreateInput,
  ): Promise<void> {
    await this.prisma.sorteTentativa.create({ data });
  }

  async listarTentativas(params: {
    userId: number;
    skip: number;
    take: number;
  }): Promise<{ data: SorteTentativa[]; total: number }> {
    const where = { userId: params.userId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteTentativa.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.sorteTentativa.count({ where }),
    ]);
    return { data, total };
  }
}

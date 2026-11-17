import { Injectable } from '@nestjs/common';
import {
  Prisma,
  SorteCampanha,
  SorteCampanhaEstado,
  SorteMomentoPremiado,
} from '@prisma/client';
import { SorteMomentoStatus } from 'src/associado-sorte/enums/associado-sorte.enums';
import { PrismaService } from 'src/database/prisma.service';

export interface ContagemMomentos {
  total: number;
  ganhos: number;
  disponiveis: number;
  aguardando: number;
  creditosTotal: number;
  creditosGanhos: number;
}

export type MomentoComGanhador = SorteMomentoPremiado & {
  ganhador: { id: number; name: string; cpf: string } | null;
};

export type RaspadaAuditoria = Prisma.SorteRaspadaGetPayload<object> & {
  user: { name: string; cpf: string } | null;
};

/** Campanhas e cronograma (leituras e escritas fora da transação). */
@Injectable()
export class SorteCampanhasRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listar(params: {
    where: Prisma.SorteCampanhaWhereInput;
    skip: number;
    take: number;
  }): Promise<{ data: SorteCampanha[]; total: number }> {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteCampanha.findMany({
        where: params.where,
        orderBy: [{ inicio: 'desc' }, { id: 'desc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.sorteCampanha.count({ where: params.where }),
    ]);
    return { data, total };
  }

  buscar(id: number): Promise<SorteCampanha | null> {
    return this.prisma.sorteCampanha.findUnique({ where: { id } });
  }

  criar(
    data: Prisma.SorteCampanhaUncheckedCreateInput,
  ): Promise<SorteCampanha> {
    return this.prisma.sorteCampanha.create({ data });
  }

  /** Só apaga rascunho (a regra também está no serviço). */
  async excluirRascunho(id: number): Promise<number> {
    const r = await this.prisma.sorteCampanha.deleteMany({
      where: { id, estado: SorteCampanhaEstado.RASCUNHO },
    });
    return r.count;
  }

  /** A campanha publicada da base (no máximo uma), ou `null`. */
  publicadaDaBase(baseOrigin: string): Promise<SorteCampanha | null> {
    return this.prisma.sorteCampanha.findFirst({
      where: { baseOrigin, estado: SorteCampanhaEstado.PUBLICADA },
      orderBy: { id: 'desc' },
    });
  }

  /** Campanhas publicadas cujo período acabou (o job encerra). */
  async listarPublicadasVencidas(agora: Date): Promise<number[]> {
    const linhas = await this.prisma.sorteCampanha.findMany({
      where: { estado: SorteCampanhaEstado.PUBLICADA, fim: { lte: agora } },
      select: { id: true },
      take: 20,
    });
    return linhas.map((l) => l.id);
  }

  async contarMomentos(
    campanhaIds: number[],
    agora: Date,
  ): Promise<Map<number, ContagemMomentos>> {
    const mapa = new Map<number, ContagemMomentos>();
    if (campanhaIds.length === 0) return mapa;
    for (const id of campanhaIds) {
      mapa.set(id, {
        total: 0,
        ganhos: 0,
        disponiveis: 0,
        aguardando: 0,
        creditosTotal: 0,
        creditosGanhos: 0,
      });
    }
    const [todos, ganhos, aguardando] = await Promise.all([
      this.prisma.sorteMomentoPremiado.groupBy({
        by: ['campanhaId'],
        where: { campanhaId: { in: campanhaIds } },
        _count: { _all: true },
        _sum: { creditos: true },
      }),
      this.prisma.sorteMomentoPremiado.groupBy({
        by: ['campanhaId'],
        where: { campanhaId: { in: campanhaIds }, userId: { not: null } },
        _count: { _all: true },
        _sum: { creditos: true },
      }),
      this.prisma.sorteMomentoPremiado.groupBy({
        by: ['campanhaId'],
        where: {
          campanhaId: { in: campanhaIds },
          userId: null,
          liberaEm: { gt: agora },
        },
        _count: { _all: true },
      }),
    ]);
    for (const g of todos) {
      const c = mapa.get(g.campanhaId)!;
      c.total = g._count._all;
      c.creditosTotal = g._sum.creditos ?? 0;
    }
    for (const g of ganhos) {
      const c = mapa.get(g.campanhaId)!;
      c.ganhos = g._count._all;
      c.creditosGanhos = g._sum.creditos ?? 0;
    }
    for (const g of aguardando)
      mapa.get(g.campanhaId)!.aguardando = g._count._all;
    for (const c of mapa.values()) {
      c.disponiveis = Math.max(0, c.total - c.ganhos - c.aguardando);
    }
    return mapa;
  }

  async listarMomentos(params: {
    campanhaId: number;
    status?: SorteMomentoStatus;
    agora: Date;
    skip: number;
    take: number;
  }): Promise<{ data: MomentoComGanhador[]; total: number }> {
    const { campanhaId, status, agora } = params;
    const where: Prisma.SorteMomentoPremiadoWhereInput = {
      campanhaId,
      ...(status === 'GANHO' ? { userId: { not: null } } : {}),
      ...(status === 'DISPONIVEL'
        ? { userId: null, liberaEm: { lte: agora } }
        : {}),
      ...(status === 'AGUARDANDO'
        ? { userId: null, liberaEm: { gt: agora } }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteMomentoPremiado.findMany({
        where,
        orderBy: [{ liberaEm: 'asc' }, { id: 'asc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.sorteMomentoPremiado.count({ where }),
    ]);
    const usuarios = await this.usuarios(
      data.map((m) => m.userId).filter((id): id is number => id !== null),
    );
    return {
      data: data.map((m) => ({
        ...m,
        ganhador: m.userId ? (usuarios.get(m.userId) ?? null) : null,
      })),
      total,
    };
  }

  buscarMomento(id: number): Promise<SorteMomentoPremiado | null> {
    return this.prisma.sorteMomentoPremiado.findUnique({ where: { id } });
  }

  /** Momentos em lote (auditoria), com o ganhador. */
  async lerMomentosEmLote(
    campanhaId: number,
    depoisDeId: number,
    lote: number,
  ): Promise<MomentoComGanhador[]> {
    const data = await this.prisma.sorteMomentoPremiado.findMany({
      where: { campanhaId, id: { gt: depoisDeId } },
      orderBy: { id: 'asc' },
      take: lote,
    });
    const usuarios = await this.usuarios(
      data.map((m) => m.userId).filter((id): id is number => id !== null),
    );
    return data.map((m) => ({
      ...m,
      ganhador: m.userId ? (usuarios.get(m.userId) ?? null) : null,
    }));
  }

  /** Raspadas da campanha em lote (auditoria), com nome e CPF. */
  async lerRaspadasEmLote(
    campanhaId: number,
    depoisDeId: number,
    lote: number,
  ): Promise<RaspadaAuditoria[]> {
    const data = await this.prisma.sorteRaspada.findMany({
      where: { campanhaId, id: { gt: depoisDeId } },
      orderBy: { id: 'asc' },
      take: lote,
    });
    const usuarios = await this.usuarios([
      ...new Set(data.map((r) => r.userId)),
    ]);
    return data.map((r) => ({ ...r, user: usuarios.get(r.userId) ?? null }));
  }

  /** Hora da raspada vencedora de cada momento. */
  async horaDasRaspadas(ids: number[]): Promise<Map<number, Date>> {
    const mapa = new Map<number, Date>();
    if (ids.length === 0) return mapa;
    const linhas = await this.prisma.sorteRaspada.findMany({
      where: { id: { in: ids } },
      select: { id: true, createdAt: true },
    });
    for (const l of linhas) mapa.set(l.id, l.createdAt);
    return mapa;
  }

  private async usuarios(
    ids: number[],
  ): Promise<Map<number, { id: number; name: string; cpf: string }>> {
    const mapa = new Map<number, { id: number; name: string; cpf: string }>();
    if (ids.length === 0) return mapa;
    const linhas = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true, cpf: true },
    });
    for (const u of linhas) mapa.set(u.id, u);
    return mapa;
  }
}

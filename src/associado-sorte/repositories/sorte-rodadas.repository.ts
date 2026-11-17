import { Injectable } from '@nestjs/common';
import { Prisma, SorteMecanica, SorteRodadaEstado } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';

export const rodadaAdminInclude = {
  premio: true,
  bases: true,
  _count: { select: { participacoes: true, ganhadores: true } },
} satisfies Prisma.SorteRodadaInclude;

export type RodadaAdminRecord = Prisma.SorteRodadaGetPayload<{
  include: typeof rodadaAdminInclude;
}>;

export const rodadaAppInclude = {
  premio: true,
  _count: { select: { participacoes: true } },
} satisfies Prisma.SorteRodadaInclude;

export type RodadaAppRecord = Prisma.SorteRodadaGetPayload<{
  include: typeof rodadaAppInclude;
}>;

export type ParticipanteRecord = Prisma.SorteParticipacaoGetPayload<{
  include: { user: { select: { id: true; name: true; cpf: true } } };
}>;

/** Leitura mínima usada na recusa rápida (sem transação nem trava). */
export interface RodadaLeituraRapida {
  id: number;
  mecanica: SorteMecanica;
  estado: SorteRodadaEstado;
  abertura: Date;
  encerramento: Date;
  quantidadeRestante: number;
}

/** Estados que o app enxerga (nunca rascunho nem cancelada). */
const ESTADOS_VISIVEIS_NO_APP: SorteRodadaEstado[] = [
  SorteRodadaEstado.PUBLICADA,
  SorteRodadaEstado.APURANDO,
  SorteRodadaEstado.ENCERRADA,
];

/** Rodadas, participações e lembretes (fora de transação). */
@Injectable()
export class SorteRodadasRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ painel

  criar(params: {
    data: Prisma.SorteRodadaUncheckedCreateInput;
    baseOrigins: string[];
  }): Promise<RodadaAdminRecord> {
    return this.prisma.sorteRodada.create({
      data: {
        ...params.data,
        bases: {
          create: params.baseOrigins.map((baseOrigin) => ({ baseOrigin })),
        },
      },
      include: rodadaAdminInclude,
    });
  }

  buscarAdmin(id: number): Promise<RodadaAdminRecord | null> {
    return this.prisma.sorteRodada.findUnique({
      where: { id },
      include: rodadaAdminInclude,
    });
  }

  async listarAdmin(params: {
    where: Prisma.SorteRodadaWhereInput;
    order: 'asc' | 'desc';
    skip: number;
    take: number;
  }): Promise<{ data: RodadaAdminRecord[]; total: number }> {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteRodada.findMany({
        where: params.where,
        orderBy: [{ abertura: params.order }, { id: params.order }],
        skip: params.skip,
        take: params.take,
        include: rodadaAdminInclude,
      }),
      this.prisma.sorteRodada.count({ where: params.where }),
    ]);
    return { data, total };
  }

  async somarBilhetes(rodadaId: number): Promise<number> {
    const soma = await this.prisma.sorteParticipacao.aggregate({
      where: { rodadaId },
      _sum: { bilhetes: true },
    });
    return soma._sum.bilhetes ?? 0;
  }

  async listarParticipantes(params: {
    rodadaId: number;
    skip: number;
    take: number;
  }): Promise<{ data: ParticipanteRecord[]; total: number }> {
    const where = { rodadaId: params.rodadaId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteParticipacao.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: params.skip,
        take: params.take,
        include: { user: { select: { id: true, name: true, cpf: true } } },
      }),
      this.prisma.sorteParticipacao.count({ where }),
    ]);
    return { data, total };
  }

  // --------------------------------------------------------------------- app

  /** Rodada visível na base do JWT, ou `null`. */
  buscarApp(id: number, baseOrigin: string): Promise<RodadaAppRecord | null> {
    return this.prisma.sorteRodada.findFirst({
      where: {
        id,
        estado: { in: ESTADOS_VISIVEIS_NO_APP },
        bases: { some: { baseOrigin } },
      },
      include: rodadaAppInclude,
    });
  }

  /**
   * Rodadas da tela inicial: publicadas/apurando e as encerradas há pouco
   * (para o associado ver o desfecho).
   */
  listarApp(params: {
    baseOrigin: string;
    encerradasDesde: Date;
    limite: number;
  }): Promise<RodadaAppRecord[]> {
    return this.prisma.sorteRodada.findMany({
      where: {
        bases: { some: { baseOrigin: params.baseOrigin } },
        OR: [
          {
            estado: {
              in: [SorteRodadaEstado.PUBLICADA, SorteRodadaEstado.APURANDO],
            },
          },
          {
            estado: SorteRodadaEstado.ENCERRADA,
            updatedAt: { gte: params.encerradasDesde },
          },
        ],
      },
      include: rodadaAppInclude,
      orderBy: [{ abertura: 'asc' }, { id: 'asc' }],
      take: params.limite,
    });
  }

  /** Leitura simples da recusa rápida: confere também a base do JWT. */
  async leituraRapida(
    id: number,
    baseOrigin: string,
  ): Promise<RodadaLeituraRapida | null> {
    return this.prisma.sorteRodada.findFirst({
      where: {
        id,
        estado: { in: ESTADOS_VISIVEIS_NO_APP },
        bases: { some: { baseOrigin } },
      },
      select: {
        id: true,
        mecanica: true,
        estado: true,
        abertura: true,
        encerramento: true,
        quantidadeRestante: true,
      },
    });
  }

  /** Situação do associado nas rodadas informadas. */
  async situacaoDoAssociado(rodadaIds: number[], userId: number) {
    if (rodadaIds.length === 0) {
      return { participacoes: [], ganhadores: [], lembretes: [] };
    }
    const [participacoes, ganhadores, lembretes] =
      await this.prisma.$transaction([
        this.prisma.sorteParticipacao.findMany({
          where: { rodadaId: { in: rodadaIds }, userId },
          select: { rodadaId: true, bilhetes: true, creditosGastos: true },
        }),
        this.prisma.sorteGanhador.findMany({
          where: { rodadaId: { in: rodadaIds }, userId },
          select: { id: true, rodadaId: true, situacao: true },
        }),
        this.prisma.sorteLembrete.findMany({
          where: { rodadaId: { in: rodadaIds }, userId },
          select: { rodadaId: true },
        }),
      ]);
    return { participacoes, ganhadores, lembretes };
  }

  // --------------------------------------------------------------- lembretes

  async criarLembrete(rodadaId: number, userId: number): Promise<void> {
    await this.prisma.sorteLembrete.createMany({
      data: [{ rodadaId, userId }],
      skipDuplicates: true,
    });
  }

  async removerLembrete(rodadaId: number, userId: number): Promise<void> {
    await this.prisma.sorteLembrete.deleteMany({ where: { rodadaId, userId } });
  }

  /** Rodadas que abrem dentro da janela e ainda não tiveram lembrete. */
  listarParaLembrar(agora: Date, ate: Date) {
    return this.prisma.sorteRodada.findMany({
      where: {
        estado: SorteRodadaEstado.PUBLICADA,
        lembreteEnviadoEm: null,
        abertura: { gt: agora, lte: ate },
      },
      select: {
        id: true,
        titulo: true,
        abertura: true,
        premio: { select: { nome: true } },
      },
    });
  }

  /** Marca o lembrete como enviado; `false` se outra execução já marcou. */
  async reivindicarLembrete(rodadaId: number, agora: Date): Promise<boolean> {
    const r = await this.prisma.sorteRodada.updateMany({
      where: { id: rodadaId, lembreteEnviadoEm: null },
      data: { lembreteEnviadoEm: agora },
    });
    return r.count === 1;
  }

  listarDestinatariosDoLembrete(rodadaId: number) {
    return this.prisma.sorteLembrete.findMany({
      where: {
        rodadaId,
        user: { isActive: true, expoPushToken: { not: null } },
      },
      select: { user: { select: { id: true, expoPushToken: true } } },
    });
  }

  // ------------------------------------------------------- ciclo (job BullMQ)

  /** Sorteios publicados cujo encerramento já passou. */
  async listarSorteiosVencidos(agora: Date): Promise<number[]> {
    const linhas = await this.prisma.sorteRodada.findMany({
      where: {
        mecanica: SorteMecanica.SORTEIO,
        estado: {
          in: [SorteRodadaEstado.PUBLICADA, SorteRodadaEstado.APURANDO],
        },
        encerramento: { lte: agora },
      },
      select: { id: true },
      orderBy: { encerramento: 'asc' },
      take: 50,
    });
    return linhas.map((l) => l.id);
  }

  /** Marca o sorteio como APURANDO (visibilidade; a apuração revalida). */
  async marcarApurando(rodadaId: number): Promise<void> {
    await this.prisma.sorteRodada.updateMany({
      where: { id: rodadaId, estado: SorteRodadaEstado.PUBLICADA },
      data: { estado: SorteRodadaEstado.APURANDO },
    });
  }

  /** Encerra corridas e vitrines vencidas ou esgotadas. Devolve quantas. */
  async encerrarCorridasEResgates(agora: Date): Promise<number> {
    const r = await this.prisma.sorteRodada.updateMany({
      where: {
        mecanica: { in: [SorteMecanica.CORRIDA, SorteMecanica.RESGATE] },
        estado: SorteRodadaEstado.PUBLICADA,
        OR: [
          { encerramento: { lte: agora } },
          { quantidadeRestante: { lte: 0 } },
        ],
      },
      data: { estado: SorteRodadaEstado.ENCERRADA },
    });
    return r.count;
  }

  listarProximas(baseOrigin: string, agora: Date, limite: number) {
    return this.prisma.sorteRodada.findMany({
      where: {
        bases: { some: { baseOrigin } },
        estado: SorteRodadaEstado.PUBLICADA,
        encerramento: { gt: agora },
      },
      include: rodadaAdminInclude,
      orderBy: [{ abertura: 'asc' }, { id: 'asc' }],
      take: limite,
    });
  }
}

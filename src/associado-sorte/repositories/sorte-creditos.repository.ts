import { Injectable } from '@nestjs/common';
import {
  Prisma,
  SorteCarteira,
  SorteColetaDiaria,
  SorteCreditoLancamento,
  UserRole,
} from '@prisma/client';
import { diaParaDate } from 'src/associado-sorte/helpers/sorte-data.helper';
import { PrismaService } from 'src/database/prisma.service';

export interface UsuarioSorte {
  id: number;
  name: string;
  isActive: boolean;
  expoPushToken: string | null;
}

export type AssociadoComCarteira = Prisma.userGetPayload<{
  select: {
    id: true;
    name: true;
    cpf: true;
    baseOrigin: true;
    isActive: true;
    sorteCarteira: true;
    sorteInscricao: true;
  };
}>;

const selecaoAssociado = {
  id: true,
  name: true,
  cpf: true,
  baseOrigin: true,
  isActive: true,
  sorteCarteira: true,
  sorteInscricao: true,
} satisfies Prisma.userSelect;

/**
 * Carteira, extrato e coleta diária (leituras fora de transação) e a leitura
 * da tabela `user` que o módulo precisa: nome, `isActive` e token de push.
 */
@Injectable()
export class SorteCreditosRepository {
  constructor(private readonly prisma: PrismaService) {}

  buscarUsuario(userId: number): Promise<UsuarioSorte | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, isActive: true, expoPushToken: true },
    });
  }

  /**
   * Cria a carteira se ainda não existir (`INSERT IGNORE`), para que a
   * transação possa travá-la com `FOR UPDATE`.
   */
  async garantirCarteira(userId: number, baseOrigin: string): Promise<void> {
    await this.prisma.sorteCarteira.createMany({
      data: [{ userId, baseOrigin }],
      skipDuplicates: true,
    });
  }

  buscarCarteira(userId: number): Promise<SorteCarteira | null> {
    return this.prisma.sorteCarteira.findUnique({ where: { userId } });
  }

  buscarColeta(userId: number, dia: string): Promise<SorteColetaDiaria | null> {
    return this.prisma.sorteColetaDiaria.findUnique({
      where: { userId_dia: { userId, dia: diaParaDate(dia) } },
    });
  }

  async listarLancamentos(params: {
    userId: number;
    skip: number;
    take: number;
  }): Promise<{ data: SorteCreditoLancamento[]; total: number }> {
    const where = { userId: params.userId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sorteCreditoLancamento.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.sorteCreditoLancamento.count({ where }),
    ]);
    return { data, total };
  }

  /** Busca do painel: nome ou CPF, só associados (não lista ADMIN do app). */
  async buscarAssociados(params: {
    busca?: string;
    baseOrigin?: string;
    inscrito?: boolean;
    skip: number;
    take: number;
  }): Promise<{ data: AssociadoComCarteira[]; total: number }> {
    const termo = (params.busca ?? '').trim();
    const digitos = termo.replace(/\D/g, '');
    const filtros: Prisma.userWhereInput[] = [];
    if (termo) {
      filtros.push({
        OR: [
          { name: { contains: termo } },
          ...(digitos.length >= 3 ? [{ cpf: { contains: digitos } }] : []),
        ],
      });
    } else if (params.inscrito === undefined) {
      // Sem termo: só quem já tem carteira ou inscrição (evita listar a base inteira).
      filtros.push({
        OR: [
          { sorteCarteira: { isNot: null } },
          { sorteInscricao: { isNot: null } },
        ],
      });
    }
    if (params.inscrito === true) {
      filtros.push({ sorteInscricao: { is: { inscrito: true } } });
    } else if (params.inscrito === false) {
      filtros.push({ sorteInscricao: { is: { inscrito: false } } });
    }
    const where: Prisma.userWhereInput = {
      role: UserRole.USER,
      ...(params.baseOrigin ? { baseOrigin: params.baseOrigin } : {}),
      AND: filtros,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: params.skip,
        take: params.take,
        select: selecaoAssociado,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { data, total };
  }

  buscarAssociado(userId: number): Promise<AssociadoComCarteira | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: selecaoAssociado,
    });
  }

  // ------------------------------------------------------------- indicadores

  contarColetasDoDia(baseOrigin: string, dia: string): Promise<number> {
    return this.prisma.sorteColetaDiaria.count({
      where: { baseOrigin, dia: diaParaDate(dia) },
    });
  }

  /** Créditos em circulação: soma dos saldos da base. */
  async somarSaldos(baseOrigin: string): Promise<number> {
    const soma = await this.prisma.sorteCarteira.aggregate({
      where: { baseOrigin },
      _sum: { saldo: true },
    });
    return soma._sum.saldo ?? 0;
  }

  contarCarteirasComSaldo(baseOrigin: string): Promise<number> {
    return this.prisma.sorteCarteira.count({
      where: { baseOrigin, saldo: { gt: 0 } },
    });
  }

  /**
   * Créditos colocados nas carteiras da base: todo lançamento positivo,
   * menos estorno (que só devolve o que já tinha sido creditado).
   */
  async somarCreditosDistribuidos(baseOrigin: string): Promise<number> {
    const soma = await this.prisma.sorteCreditoLancamento.aggregate({
      where: { baseOrigin, valor: { gt: 0 }, tipo: { not: 'ESTORNO' } },
      _sum: { valor: true },
    });
    return soma._sum.valor ?? 0;
  }

  /**
   * Créditos gastos em participações e resgates, já descontados os estornos
   * (rodada cancelada, ganhador cancelado com devolução).
   */
  async somarCreditosGastos(baseOrigin: string): Promise<number> {
    const soma = await this.prisma.sorteCreditoLancamento.aggregate({
      where: {
        baseOrigin,
        tipo: {
          in: ['PARTICIPACAO_SORTEIO', 'RESGATE', 'COMPRA_LOJA', 'ESTORNO'],
        },
      },
      _sum: { valor: true },
    });
    return Math.max(0, -(soma._sum.valor ?? 0));
  }
}

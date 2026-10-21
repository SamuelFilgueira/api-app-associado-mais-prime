import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { inicioDoDia } from 'src/direct-partners/helpers/direct-partner.helpers';

/** Cupons com contagem de resgates, na ordem de exibição. */
export const couponAdminInclude = {
  orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  include: { _count: { select: { redemptions: true } } },
} satisfies Prisma.DirectPartner$couponsArgs;

export const partnerAdminInclude = {
  bases: true,
  coupons: couponAdminInclude,
} satisfies Prisma.DirectPartnerInclude;

export type PartnerAdminRecord = Prisma.DirectPartnerGetPayload<{
  include: typeof partnerAdminInclude;
}>;

export type CouponAdminRecord = Prisma.DirectPartnerCouponGetPayload<{
  include: { _count: { select: { redemptions: true } } };
}>;

export type PartnerAppRecord = Prisma.DirectPartnerGetPayload<{
  include: { coupons: true };
}>;

export type RedemptionRecord = Prisma.DirectPartnerCouponRedemptionGetPayload<{
  include: { user: { select: { id: true; name: true; cpf: true } } };
}>;

/**
 * Acesso a dados dos parceiros diretos. Leituras do app sempre recebem a
 * base do JWT e filtram `bases.some({ baseOrigin })` (§4.1) e cupons
 * visíveis (§4.3).
 */
@Injectable()
export class DirectPartnersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Condição Prisma de cupom visível (§4.3) para o instante `agora`. */
  cupomVisivelWhere(
    agora: Date = new Date(),
  ): Prisma.DirectPartnerCouponWhereInput {
    return {
      isActive: true,
      validUntil: { gte: inicioDoDia(agora) },
      OR: [{ validFrom: null }, { validFrom: { lte: agora } }],
    };
  }

  /** Condição Prisma de parceiro visível na base (§4.2). */
  parceiroVisivelWhere(
    baseOrigin: string,
    agora: Date = new Date(),
  ): Prisma.DirectPartnerWhereInput {
    return {
      isActive: true,
      deletedAt: null,
      bases: { some: { baseOrigin } },
      coupons: { some: this.cupomVisivelWhere(agora) },
    };
  }

  // ---------------------------------------------------------------- painel

  async listarPainel(params: {
    where: Prisma.DirectPartnerWhereInput;
    orderBy: Prisma.DirectPartnerOrderByWithRelationInput[];
    skip: number;
    take: number;
  }): Promise<{ data: PartnerAdminRecord[]; total: number }> {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.directPartner.findMany({
        where: params.where,
        orderBy: params.orderBy,
        skip: params.skip,
        take: params.take,
        include: partnerAdminInclude,
      }),
      this.prisma.directPartner.count({ where: params.where }),
    ]);
    return { data, total };
  }

  buscarPainelPorId(id: number): Promise<PartnerAdminRecord | null> {
    return this.prisma.directPartner.findUnique({
      where: { id },
      include: partnerAdminInclude,
    });
  }

  async criar(params: {
    data: Prisma.DirectPartnerUncheckedCreateInput;
    baseOrigins: string[];
    coupons: Prisma.DirectPartnerCouponCreateWithoutPartnerInput[];
  }): Promise<PartnerAdminRecord> {
    return this.prisma.directPartner.create({
      data: {
        ...params.data,
        bases: {
          create: params.baseOrigins.map((baseOrigin) => ({ baseOrigin })),
        },
        coupons: params.coupons.length ? { create: params.coupons } : undefined,
      },
      include: partnerAdminInclude,
    });
  }

  async atualizar(params: {
    id: number;
    data: Prisma.DirectPartnerUncheckedUpdateInput;
    baseOrigins?: string[];
  }): Promise<PartnerAdminRecord> {
    return this.prisma.$transaction(async (tx) => {
      if (params.baseOrigins) {
        await tx.directPartnerBase.deleteMany({
          where: { partnerId: params.id },
        });
        await tx.directPartnerBase.createMany({
          data: params.baseOrigins.map((baseOrigin) => ({
            partnerId: params.id,
            baseOrigin,
          })),
        });
      }
      return tx.directPartner.update({
        where: { id: params.id },
        data: params.data,
        include: partnerAdminInclude,
      });
    });
  }

  async excluirSoft(id: number): Promise<void> {
    await this.prisma.directPartner.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });
  }

  async excluirDefinitivo(id: number): Promise<void> {
    await this.prisma.directPartner.delete({ where: { id } });
  }

  async atualizarLogo(id: number, logoUrl: string | null): Promise<void> {
    await this.prisma.directPartner.update({
      where: { id },
      data: { logoUrl },
    });
  }

  /** `sortOrder = índice` para cada id; ids não listados ficam como estão. */
  async reordenar(ids: number[]): Promise<void> {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.directPartner.updateMany({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
  }

  // ---------------------------------------------------------------- cupons

  listarCupons(partnerId: number): Promise<CouponAdminRecord[]> {
    return this.prisma.directPartnerCoupon.findMany({
      where: { partnerId },
      ...couponAdminInclude,
    });
  }

  buscarCupom(
    partnerId: number,
    couponId: number,
  ): Promise<CouponAdminRecord | null> {
    return this.prisma.directPartnerCoupon.findFirst({
      where: { id: couponId, partnerId },
      include: couponAdminInclude.include,
    });
  }

  criarCupom(
    partnerId: number,
    data: Prisma.DirectPartnerCouponCreateWithoutPartnerInput,
  ): Promise<CouponAdminRecord> {
    return this.prisma.directPartnerCoupon.create({
      data: { ...data, partnerId },
      include: couponAdminInclude.include,
    });
  }

  atualizarCupom(
    couponId: number,
    data: Prisma.DirectPartnerCouponUncheckedUpdateInput,
  ): Promise<CouponAdminRecord> {
    return this.prisma.directPartnerCoupon.update({
      where: { id: couponId },
      data,
      include: couponAdminInclude.include,
    });
  }

  async excluirCupom(couponId: number): Promise<void> {
    await this.prisma.directPartnerCoupon.delete({ where: { id: couponId } });
  }

  // ------------------------------------------------------------- resgates

  async listarResgates(params: {
    couponId: number;
    baseOrigin?: string;
    skip: number;
    take: number;
  }): Promise<{ data: RedemptionRecord[]; total: number }> {
    const where: Prisma.DirectPartnerCouponRedemptionWhereInput = {
      couponId: params.couponId,
      ...(params.baseOrigin ? { baseOrigin: params.baseOrigin } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.directPartnerCouponRedemption.findMany({
        where,
        orderBy: { redeemedAt: 'desc' },
        skip: params.skip,
        take: params.take,
        include: { user: { select: { id: true, name: true, cpf: true } } },
      }),
      this.prisma.directPartnerCouponRedemption.count({ where }),
    ]);
    return { data, total };
  }

  /** Resgates do associado nos cupons informados, mais recente primeiro. */
  listarResgatesDoAssociado(
    couponIds: number[],
    userId: number,
  ): Promise<{ couponId: number; redeemedAt: Date }[]> {
    if (couponIds.length === 0) return Promise.resolve([]);
    return this.prisma.directPartnerCouponRedemption.findMany({
      where: { couponId: { in: couponIds }, userId },
      orderBy: { redeemedAt: 'desc' },
      select: { couponId: true, redeemedAt: true },
    });
  }

  /** Registro simples (cupom reutilizável — métrica). */
  registrarUso(params: {
    couponId: number;
    userId: number;
    baseOrigin: string;
  }): Promise<{ redeemedAt: Date }> {
    return this.prisma.directPartnerCouponRedemption.create({
      data: params,
      select: { redeemedAt: true },
    });
  }

  /**
   * Resgate de uso único: trava a linha do cupom (`SELECT ... FOR UPDATE`)
   * para serializar resgates concorrentes do mesmo par cupom+associado e
   * devolve o resgate existente (se houver) ou cria um novo.
   */
  resgatarUsoUnico(params: {
    couponId: number;
    userId: number;
    baseOrigin: string;
  }): Promise<{ criado: boolean; redeemedAt: Date }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM DirectPartnerCoupon WHERE id = ${params.couponId} FOR UPDATE`;

      const existente = await tx.$queryRaw<{ redeemedAt: Date }[]>`
        SELECT redeemedAt FROM DirectPartnerCouponRedemption
        WHERE couponId = ${params.couponId} AND userId = ${params.userId}
        ORDER BY redeemedAt ASC LIMIT 1 FOR UPDATE`;

      if (existente.length > 0) {
        return { criado: false, redeemedAt: new Date(existente[0].redeemedAt) };
      }

      const criado = await tx.directPartnerCouponRedemption.create({
        data: params,
        select: { redeemedAt: true },
      });
      return { criado: true, redeemedAt: criado.redeemedAt };
    });
  }

  // ------------------------------------------------------------------ app

  /** Parceiros visíveis na base com apenas os cupons visíveis embutidos. */
  listarApp(params: {
    baseOrigin: string;
    where?: Prisma.DirectPartnerWhereInput;
    agora?: Date;
  }): Promise<PartnerAppRecord[]> {
    const agora = params.agora ?? new Date();
    return this.prisma.directPartner.findMany({
      where: {
        AND: [
          this.parceiroVisivelWhere(params.baseOrigin, agora),
          params.where ?? {},
        ],
      },
      include: {
        coupons: {
          where: this.cupomVisivelWhere(agora),
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ featured: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  buscarAppPorId(params: {
    id: number;
    baseOrigin: string;
    agora?: Date;
  }): Promise<PartnerAppRecord | null> {
    const agora = params.agora ?? new Date();
    return this.prisma.directPartner.findFirst({
      where: {
        id: params.id,
        ...this.parceiroVisivelWhere(params.baseOrigin, agora),
      },
      include: {
        coupons: {
          where: this.cupomVisivelWhere(agora),
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    });
  }
}

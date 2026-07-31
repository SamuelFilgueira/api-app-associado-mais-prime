import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { ListReinspectionPaymentsDto } from 'src/reinspection/dto/list-reinspection-payments.dto';

@Injectable()
export class ReinspectionPaymentsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  private mapSituacaoBoleto(situacaoBoleto: string | null): string {
    if (!situacaoBoleto) {
      return 'Nao informado';
    }

    const normalized = String(situacaoBoleto).trim();

    const statusMap: Record<string, string> = {
      '1': 'Pago',
      '2': 'Aberto',
      '3': 'Cancelado',
      '4': 'Liquidado',
      '5': 'Vencido',
      CRIADO: 'Criado',
      PENDENTE: 'Pendente de verificacao',
    };

    return statusMap[normalized] ?? `Status ${normalized}`;
  }

  private mapPaymentForAdmin(payment: {
    id: number;
    userVehicleId: number;
    nossoNumero: string | null;
    linhaDigitavel: string | null;
    linkBoleto: string | null;
    situacaoBoleto: string;
    cancelado: boolean;
    boletoCriadoEm: Date;
    pago: boolean;
    pagoEm: Date | null;
    createdAt: Date;
    updatedAt: Date;
    userVehicle: {
      plate: string | null;
      chassi: string;
      user: {
        name: string;
        cpf: string;
      };
    };
  }) {
    return {
      id: payment.id,
      userVehicleId: payment.userVehicleId,
      nossoNumero: payment.nossoNumero,
      linhaDigitavel: payment.linhaDigitavel,
      linkBoleto: payment.linkBoleto,
      situacaoBoletoCodigo: payment.situacaoBoleto,
      situacaoBoletoTexto: this.mapSituacaoBoleto(payment.situacaoBoleto),
      cancelado: payment.cancelado,
      pago: payment.pago,
      pagoTexto: payment.pago ? 'Pago' : 'Nao pago',
      boletoCriadoEm: payment.boletoCriadoEm,
      pagoEm: payment.pagoEm,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      placa: payment.userVehicle.plate,
      chassi: payment.userVehicle.chassi,
      associadoNome: payment.userVehicle.user.name,
      associadoCpf: payment.userVehicle.user.cpf,
    };
  }

  async list(query: ListReinspectionPaymentsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ReinspectionPaymentWhereInput = {};

    if (query.nossoNumero) {
      where.nossoNumero = { contains: query.nossoNumero.trim() };
    }

    if (query.situacaoBoleto) {
      where.situacaoBoleto = query.situacaoBoleto.trim();
    }

    if (query.pago !== undefined) {
      where.pago = query.pago === 'true';
    }

    if (query.userVehicleId) {
      where.userVehicleId = query.userVehicleId;
    }

    if (query.plate) {
      where.userVehicle = {
        plate: {
          contains: query.plate.trim(),
        },
      };
    }

    const [total, payments] = await this.prisma.$transaction([
      this.prisma.reinspectionPayment.count({ where }),
      this.prisma.reinspectionPayment.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          userVehicleId: true,
          nossoNumero: true,
          linhaDigitavel: true,
          linkBoleto: true,
          situacaoBoleto: true,
          cancelado: true,
          boletoCriadoEm: true,
          pago: true,
          pagoEm: true,
          createdAt: true,
          updatedAt: true,
          userVehicle: {
            select: {
              plate: true,
              chassi: true,
              user: {
                select: {
                  name: true,
                  cpf: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: payments.map((payment) => this.mapPaymentForAdmin(payment)),
    };
  }

  async getById(id: number) {
    const payment = await this.prisma.reinspectionPayment.findUnique({
      where: { id },
      select: {
        id: true,
        userVehicleId: true,
        nossoNumero: true,
        linhaDigitavel: true,
        linkBoleto: true,
        situacaoBoleto: true,
        cancelado: true,
        boletoCriadoEm: true,
        pago: true,
        pagoEm: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: {
          select: {
            plate: true,
            chassi: true,
            user: {
              select: {
                name: true,
                cpf: true,
              },
            },
          },
        },
      },
    });

    if (!payment) {
      return {
        found: false,
        message: 'Boleto de revistoria nao encontrado',
      };
    }

    return {
      found: true,
      data: this.mapPaymentForAdmin(payment),
    };
  }

  async listByUserVehicle(userVehicleId: number) {
    const payments = await this.prisma.reinspectionPayment.findMany({
      where: { userVehicleId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        userVehicleId: true,
        nossoNumero: true,
        linhaDigitavel: true,
        linkBoleto: true,
        situacaoBoleto: true,
        cancelado: true,
        boletoCriadoEm: true,
        pago: true,
        pagoEm: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: {
          select: {
            plate: true,
            chassi: true,
            user: {
              select: {
                name: true,
                cpf: true,
              },
            },
          },
        },
      },
    });

    return {
      userVehicleId,
      total: payments.length,
      data: payments.map((payment) => this.mapPaymentForAdmin(payment)),
    };
  }

  async cancel(id: number) {
    const payment = await this.prisma.reinspectionPayment.findUnique({
      where: { id },
      select: { id: true, cancelado: true },
    });

    if (!payment) {
      return {
        found: false,
        message: 'Boleto de revistoria nao encontrado',
      };
    }

    if (!payment.cancelado) {
      await this.prisma.reinspectionPayment.update({
        where: { id },
        data: { cancelado: true },
      });
    }

    return {
      found: true,
      message: 'Boleto de revistoria cancelado com sucesso',
    };
  }
}

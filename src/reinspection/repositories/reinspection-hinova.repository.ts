import { Injectable } from '@nestjs/common';
import {
  Prisma,
  ReinspectionHinovaEnvioOrigem,
  ReinspectionHinovaEnvioStatus,
  ReinspectionStatus,
} from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import {
  ERRO_MAX_CHARS,
  FotoParaEnvio,
  ResultadoEnvioFoto,
  statusDoEnvio,
  truncar,
} from 'src/reinspection/domain/hinova-envio';

export interface TentativaDeEnvio {
  reinspectionId: number;
  origem: ReinspectionHinovaEnvioOrigem;
  status: ReinspectionHinovaEnvioStatus;
  baseOrigin: string;
  codigoVeiculo: number | null;
  adminPanelUserId?: number;
  adminPanelUserEmail?: string;
  fotos: ResultadoEnvioFoto[];
  totalInseridas: number;
  httpStatus: number | null;
  responseBody?: Prisma.InputJsonValue;
  errorMessage: string | null;
  duracaoMs: number;
  agora: Date;
}

/** Persistência do envio de fotos da revistoria à Hinova. */
@Injectable()
export class ReinspectionHinovaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async paraEnvio(reinspectionId: number) {
    const revistoria = await this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: {
        id: true,
        status: true,
        codigoVeiculo: true,
        userVehicle: { select: { user: { select: { baseOrigin: true } } } },
      },
    });
    if (!revistoria) return null;
    return {
      id: revistoria.id,
      status: revistoria.status,
      codigoVeiculo: revistoria.codigoVeiculo,
      baseOrigin: revistoria.userVehicle?.user?.baseOrigin ?? null,
    };
  }

  fotos(reinspectionId: number): Promise<FotoParaEnvio[]> {
    return this.prisma.reinspectionPhoto.findMany({
      where: { reinspectionId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        nomeArquivo: true,
        codigoTipo: true,
        url: true,
        sentToHinova: true,
      },
    });
  }

  /**
   * Reivindica o lease do envio: só afeta a linha se não houver lease ou se
   * ele já venceu. Devolve o vencimento gravado (a "senha" para soltar) ou
   * `null` quando outro envio está em andamento.
   */
  async reivindicarLease(
    reinspectionId: number,
    agora: Date,
    duracaoMs: number,
  ): Promise<Date | null> {
    const leaseAte = new Date(agora.getTime() + duracaoMs);
    const { count } = await this.prisma.reinspection.updateMany({
      where: {
        id: reinspectionId,
        OR: [
          { hinovaEnvioLeaseAte: null },
          { hinovaEnvioLeaseAte: { lt: agora } },
        ],
      },
      data: { hinovaEnvioLeaseAte: leaseAte },
    });
    return count > 0 ? leaseAte : null;
  }

  /** Solta o lease, desde que ainda seja o desta execução. */
  async soltarLease(reinspectionId: number, leaseAte: Date): Promise<void> {
    await this.prisma.reinspection.updateMany({
      where: { id: reinspectionId, hinovaEnvioLeaseAte: leaseAte },
      data: { hinovaEnvioLeaseAte: null },
    });
  }

  /**
   * Grava o resultado por foto, a linha de auditoria da tentativa e o
   * consolidado da revistoria. `sentToHinova` só vira `true` para a foto que
   * a Hinova confirmou como inserida.
   */
  async registrarTentativa(tentativa: TentativaDeEnvio): Promise<{
    envioId: number;
    hinovaEnvioStatus: ReinspectionHinovaEnvioStatus;
  }> {
    const { agora, fotos } = tentativa;

    await this.prisma.$transaction(
      fotos.map((foto) =>
        this.prisma.reinspectionPhoto.update({
          where: { id: foto.photoId },
          data: {
            hinovaTentativas: { increment: 1 },
            ...(foto.inserida
              ? {
                  sentToHinova: true,
                  hinovaSituacao: truncar(foto.situacao, 50),
                  hinovaEnviadaEm: agora,
                  hinovaUltimoErro: null,
                }
              : {
                  ...(foto.situacao != null
                    ? { hinovaSituacao: truncar(foto.situacao, 50) }
                    : {}),
                  hinovaUltimoErro: truncar(foto.erro, ERRO_MAX_CHARS),
                }),
          },
        }),
      ),
    );

    const envio = await this.prisma.reinspectionHinovaEnvio.create({
      data: {
        reinspectionId: tentativa.reinspectionId,
        origem: tentativa.origem,
        status: tentativa.status,
        baseOrigin: tentativa.baseOrigin,
        codigoVeiculo: tentativa.codigoVeiculo,
        adminPanelUserId: tentativa.adminPanelUserId ?? null,
        adminPanelUserEmail: tentativa.adminPanelUserEmail ?? null,
        totalFotos: fotos.length,
        totalInseridas: tentativa.totalInseridas,
        totalFalhas: fotos.length - tentativa.totalInseridas,
        photoIds: fotos.map((f) => f.photoId),
        httpStatus: tentativa.httpStatus,
        responseBody: tentativa.responseBody ?? Prisma.JsonNull,
        errorMessage: tentativa.errorMessage,
        duracaoMs: tentativa.duracaoMs,
      },
      select: { id: true },
    });

    const hinovaEnvioStatus = await this.consolidar(
      tentativa.reinspectionId,
      agora,
    );
    return { envioId: envio.id, hinovaEnvioStatus };
  }

  /** Revistorias aprovadas/finalizadas com fotos ainda não inseridas. */
  listarPendentes() {
    return this.prisma.reinspection.findMany({
      where: {
        status: {
          in: [ReinspectionStatus.APROVADA, ReinspectionStatus.FINALIZADA],
        },
        photos: { some: { sentToHinova: false } },
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        userVehicleId: true,
        vehicleType: true,
        status: true,
        hinovaEnvioStatus: true,
        hinovaUltimoEnvioEm: true,
        createdAt: true,
        updatedAt: true,
        userVehicle: { select: { chassi: true, plate: true } },
        photos: {
          where: { sentToHinova: false },
          select: { id: true, hinovaUltimoErro: true, hinovaTentativas: true },
        },
        _count: { select: { photos: true, hinovaEnvios: true } },
      },
    });
  }

  consolidado(reinspectionId: number) {
    return this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: { id: true, hinovaEnvioStatus: true, hinovaUltimoEnvioEm: true },
    });
  }

  envios(reinspectionId: number) {
    return this.prisma.reinspectionHinovaEnvio.findMany({
      where: { reinspectionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async consolidar(
    reinspectionId: number,
    agora: Date,
  ): Promise<ReinspectionHinovaEnvioStatus> {
    const [total, enviadas] = await this.prisma.$transaction([
      this.prisma.reinspectionPhoto.count({ where: { reinspectionId } }),
      this.prisma.reinspectionPhoto.count({
        where: { reinspectionId, sentToHinova: true },
      }),
    ]);
    const status = statusDoEnvio(total, enviadas);

    await this.prisma.reinspection.update({
      where: { id: reinspectionId },
      data: { hinovaEnvioStatus: status, hinovaUltimoEnvioEm: agora },
    });
    return status;
  }
}

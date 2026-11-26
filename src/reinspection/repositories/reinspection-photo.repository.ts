import { Injectable } from '@nestjs/common';
import {
  Prisma,
  ReinspectionPhotoStatus,
  ReinspectionVehicleType,
} from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { ClienteRevistoria } from 'src/reinspection/repositories/reinspection.repository';

/** Foto devolvida pelas rotas de avaliação do painel. */
const FOTO_AVALIADA_SELECT = {
  id: true,
  reinspectionId: true,
  nomeArquivo: true,
  templatePhotoId: true,
  status: true,
} satisfies Prisma.ReinspectionPhotoSelect;

export interface NovaFoto {
  nomeArquivo: string;
  codigoTipo?: number;
  templatePhotoId?: number;
  url: string;
}

/** Fotos da revistoria e fotos de template. */
@Injectable()
export class ReinspectionPhotoRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Fotos ─────────────────────────────────────────────────────────────────

  async adicionar(reinspectionId: number, fotos: NovaFoto[]): Promise<void> {
    await this.prisma.reinspectionPhoto.createMany({
      data: fotos.map((foto) => ({
        reinspectionId,
        nomeArquivo: foto.nomeArquivo,
        codigoTipo: foto.codigoTipo ?? null,
        templatePhotoId: foto.templatePhotoId ?? null,
        url: foto.url,
        status: ReinspectionPhotoStatus.PENDENTE,
        sentToHinova: false,
      })),
    });
  }

  contar(reinspectionId: number): Promise<number> {
    return this.prisma.reinspectionPhoto.count({ where: { reinspectionId } });
  }

  async existeReprovada(
    reinspectionId: number,
    opcoes: { excetoId?: number; cliente?: ClienteRevistoria } = {},
  ): Promise<boolean> {
    const achada = await (
      opcoes.cliente ?? this.prisma
    ).reinspectionPhoto.findFirst({
      where: {
        reinspectionId,
        status: ReinspectionPhotoStatus.REPROVADA,
        ...(opcoes.excetoId != null ? { NOT: { id: opcoes.excetoId } } : {}),
      },
      select: { id: true },
    });
    return achada !== null;
  }

  listarDaRevistoria(reinspectionId: number) {
    return this.prisma.reinspectionPhoto.findMany({
      where: { reinspectionId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        reinspectionId: true,
        nomeArquivo: true,
        codigoTipo: true,
        url: true,
        status: true,
        hinovaSituacao: true,
        sentToHinova: true,
        hinovaEnviadaEm: true,
        hinovaTentativas: true,
        hinovaUltimoErro: true,
        createdAt: true,
      },
    });
  }

  listarReprovadas(reinspectionId: number) {
    return this.prisma.reinspectionPhoto.findMany({
      where: { reinspectionId, status: ReinspectionPhotoStatus.REPROVADA },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        url: true,
        templatePhotoId: true,
        templatePhoto: {
          select: { id: true, photoUrl: true, ordem: true, vehicleType: true },
        },
      },
    });
  }

  /** Foto com a revistoria e o dono do veículo (avaliação e reenvio). */
  comRevistoria(photoId: number) {
    return this.prisma.reinspectionPhoto.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        reinspectionId: true,
        nomeArquivo: true,
        templatePhotoId: true,
        status: true,
        reinspection: {
          select: {
            vehicleType: true,
            userVehicle: {
              select: { userId: true, chassi: true, plate: true },
            },
          },
        },
      },
    });
  }

  /** Grava a avaliação do painel (aprovada/reprovada). */
  avaliar(
    photoId: number,
    dados: { status: ReinspectionPhotoStatus; templatePhotoId?: number | null },
    cliente: ClienteRevistoria,
  ) {
    return cliente.reinspectionPhoto.update({
      where: { id: photoId },
      data: dados,
      select: FOTO_AVALIADA_SELECT,
    });
  }

  /**
   * Troca o arquivo da foto reprovada e a devolve para análise. Só afeta a
   * foto que AINDA está REPROVADA: de dois reenvios simultâneos da mesma
   * foto, um ganha (`true`) e o outro não grava nada.
   */
  async marcarReenviada(
    photoId: number,
    novaUrl: string,
    cliente: ClienteRevistoria,
  ): Promise<boolean> {
    const { count } = await cliente.reinspectionPhoto.updateMany({
      where: { id: photoId, status: ReinspectionPhotoStatus.REPROVADA },
      data: {
        url: novaUrl,
        status: ReinspectionPhotoStatus.PENDENTE,
        sentToHinova: false,
        hinovaSituacao: null,
      },
    });
    return count > 0;
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  template(vehicleType: ReinspectionVehicleType, ordem: number) {
    return this.prisma.reinspectionTemplatePhoto.findUnique({
      where: { vehicleType_ordem: { vehicleType, ordem } },
      select: { id: true, photoUrl: true },
    });
  }

  salvarTemplate(
    vehicleType: ReinspectionVehicleType,
    ordem: number,
    photoUrl: string,
  ) {
    return this.prisma.reinspectionTemplatePhoto.upsert({
      where: { vehicleType_ordem: { vehicleType, ordem } },
      create: { vehicleType, ordem, photoUrl },
      update: { photoUrl },
      select: { id: true, vehicleType: true, ordem: true, photoUrl: true },
    });
  }

  listarTemplates(vehicleType?: ReinspectionVehicleType) {
    return this.prisma.reinspectionTemplatePhoto.findMany({
      where: vehicleType ? { vehicleType } : undefined,
      orderBy: { ordem: 'asc' },
      select: { photoUrl: true, ordem: true, vehicleType: true },
    });
  }
}

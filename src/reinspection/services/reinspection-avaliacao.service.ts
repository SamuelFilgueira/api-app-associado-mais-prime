import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ReinspectionPhotoStatus,
  ReinspectionStatus,
  ReinspectionVehicleType,
} from '@prisma/client';
import { extrairOrdemDoNomeArquivo } from 'src/reinspection/domain/revistoria-foto';
import {
  ORIGENS,
  estaEmAvaliacao,
  statusAposAprovarFoto,
} from 'src/reinspection/domain/revistoria-transicoes';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import {
  EstadoDaRevistoria,
  ReinspectionRepository,
} from 'src/reinspection/repositories/reinspection.repository';

/**
 * Avaliação das fotos pelo painel. Aprovar e reprovar foto decidem o status
 * da revistoria a partir das outras fotos; por isso as duas operações rodam
 * com a linha da revistoria travada — simultâneas, deixam de se sobrescrever.
 */
@Injectable()
export class ReinspectionAvaliacaoService {
  private readonly logger = new Logger(ReinspectionAvaliacaoService.name);

  constructor(
    private readonly revistorias: ReinspectionRepository,
    private readonly fotos: ReinspectionPhotoRepository,
  ) {}

  /**
   * Reprova a foto e, com ela, a revistoria. Revistoria FINALIZADA não é
   * reaberta: responde 409 e a foto fica como estava.
   */
  async reprovarFoto(photoId: number) {
    const foto = await this.fotos.comRevistoria(photoId);
    if (!foto) {
      throw new NotFoundException('Foto de revistoria não encontrada');
    }

    const templatePhotoId = await this.templateDaFoto(
      foto.templatePhotoId,
      foto.nomeArquivo,
      foto.reinspection.vehicleType,
    );

    const resultado = await this.revistorias.comRevistoriaTravada(
      foto.reinspectionId,
      async (tx) => {
        const { status } = await this.revistorias.transicionar(
          foto.reinspectionId,
          ORIGENS.REPROVAR_POR_FOTO,
          ReinspectionStatus.REPROVADA,
          { repeticaoIdempotente: true, cliente: tx },
        );
        const photo = await this.fotos.avaliar(
          foto.id,
          { status: ReinspectionPhotoStatus.REPROVADA, templatePhotoId },
          tx,
        );
        const atual = await this.revistorias.estadoOuFalha(
          foto.reinspectionId,
          tx,
        );
        return { photo, reinspection: resumoDaRevistoria(atual, status) };
      },
    );

    this.logger.warn(
      `Foto reprovada e revistoria atualizada para REPROVADA | photoId=${resultado.photo.id} | reinspectionId=${resultado.reinspection.reinspectionId} | templatePhotoId=${resultado.photo.templatePhotoId ?? 'N/A'}`,
    );
    return resultado;
  }

  /**
   * Aprova a foto. Com a revistoria ainda em avaliação, o status é
   * recalculado pelas fotos (REPROVADA se sobrar foto reprovada, senão
   * EM_ANALISE). Revistoria APROVADA ou FINALIZADA não é rebaixada: a foto é
   * aprovada e o status fica como está.
   */
  async aprovarFoto(photoId: number) {
    const foto = await this.fotos.comRevistoria(photoId);
    if (!foto) {
      throw new NotFoundException('Foto de revistoria não encontrada');
    }
    const reinspectionId = foto.reinspectionId;

    return this.revistorias.comRevistoriaTravada(reinspectionId, async (tx) => {
      const photo = await this.fotos.avaliar(
        foto.id,
        { status: ReinspectionPhotoStatus.APROVADA },
        tx,
      );

      const antes = await this.revistorias.estadoOuFalha(reinspectionId, tx);
      if (estaEmAvaliacao(antes.status)) {
        const alvo = statusAposAprovarFoto(
          await this.fotos.existeReprovada(reinspectionId, {
            excetoId: foto.id,
            cliente: tx,
          }),
        );
        if (alvo !== antes.status) {
          await this.revistorias.transicionar(
            reinspectionId,
            [antes.status],
            alvo,
            { cliente: tx },
          );
        }
      }

      const depois = await this.revistorias.estadoOuFalha(reinspectionId, tx);
      return { photo, reinspection: resumoDaRevistoria(depois, depois.status) };
    });
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /** Template da foto reprovada: o já gravado ou o da ordem no nome do arquivo. */
  private async templateDaFoto(
    templatePhotoId: number | null,
    nomeArquivo: string,
    vehicleType: ReinspectionVehicleType,
  ): Promise<number | null> {
    if (templatePhotoId != null) return templatePhotoId;

    const ordem = extrairOrdemDoNomeArquivo(nomeArquivo);
    if (ordem == null) {
      this.logger.warn(
        `Não foi possível inferir templatePhotoId: ordem ausente no nome do arquivo | nomeArquivo=${nomeArquivo}`,
      );
      return null;
    }

    const template = await this.fotos.template(vehicleType, ordem);
    if (!template) {
      this.logger.warn(
        `Não foi possível inferir templatePhotoId: template não encontrado | vehicleType=${vehicleType} | ordem=${ordem}`,
      );
      return null;
    }
    return template.id;
  }
}

function resumoDaRevistoria(
  revistoria: EstadoDaRevistoria,
  status: ReinspectionStatus,
) {
  return {
    reinspectionId: revistoria.id,
    userVehicleId: revistoria.userVehicleId,
    status,
    updatedAt: revistoria.updatedAt,
  };
}

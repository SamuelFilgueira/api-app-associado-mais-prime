import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ReinspectionPhotoStatus, ReinspectionStatus } from '@prisma/client';
import {
  UsuarioAutenticado,
  exigirDonoOuAdmin,
} from 'src/infra/auth/usuario-autenticado';
import { MailService } from 'src/infra/mail/mail.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { ORIGENS } from 'src/reinspection/domain/revistoria-transicoes';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';
import { debugLog } from 'src/shared/debug-log.util';

/** Resultado do aviso por e-mail do reenvio de foto (campo aditivo). */
export type NotificacaoDoReenvio = 'ENVIADA' | 'FALHOU';

const MSG_SO_REPROVADA = 'Somente fotos reprovadas podem ser reenviadas';

/**
 * Andamento da revistoria pelo app: marcar EM_ANALISE, reenviar foto
 * reprovada e finalizar. As rotas por `userVehicleId` agem na ÚLTIMA
 * revistoria do veículo. O associado só alcança veículo dele; token ADMIN
 * (painel) é isento.
 */
@Injectable()
export class ReinspectionAndamentoService {
  private readonly logger = new Logger(ReinspectionAndamentoService.name);

  constructor(
    private readonly revistorias: ReinspectionRepository,
    private readonly fotos: ReinspectionPhotoRepository,
    private readonly arquivos: FileUploadService,
    private readonly mail: MailService,
  ) {}

  /**
   * `PATCH /status`: PENDENTE (após o submit) ou REPROVADA (após o reenvio)
   * → EM_ANALISE. Repetição com a revistoria já EM_ANALISE responde o estado
   * atual; APROVADA e FINALIZADA não voltam para análise (409).
   */
  async marcarEmAnalise(userVehicleId: number, usuario: UsuarioAutenticado) {
    await this.veiculoDoUsuario(userVehicleId, usuario);

    const ultima = await this.revistorias.ultimaDoVeiculo(userVehicleId);
    if (!ultima) {
      return { userVehicleId, hasReinspection: false, status: null };
    }

    const { status } = await this.revistorias.transicionar(
      ultima.id,
      ORIGENS.MARCAR_EM_ANALISE,
      ReinspectionStatus.EM_ANALISE,
      { repeticaoIdempotente: true },
    );
    const atual = await this.revistorias.estadoOuFalha(ultima.id);

    return {
      userVehicleId,
      hasReinspection: true,
      reinspectionId: atual.id,
      status,
      createdAt: atual.createdAt,
      updatedAt: atual.updatedAt,
    };
  }

  /**
   * `PATCH /finalizar`: o veículo voltou a ATIVO. Qualquer estado aberto vai
   * para FINALIZADA; repetir com a revistoria já finalizada responde o
   * estado atual.
   */
  async finalizar(userVehicleId: number, usuario: UsuarioAutenticado) {
    await this.veiculoDoUsuario(userVehicleId, usuario);

    const ultima = await this.revistorias.ultimaDoVeiculo(userVehicleId);
    if (!ultima) {
      throw new NotFoundException(
        'Nenhuma revistoria encontrada para este veículo',
      );
    }

    const { status } = await this.revistorias.transicionar(
      ultima.id,
      ORIGENS.FINALIZAR,
      ReinspectionStatus.FINALIZADA,
      { repeticaoIdempotente: true },
    );
    const atual = await this.revistorias.estadoOuFalha(ultima.id);

    return {
      reinspectionId: atual.id,
      userVehicleId: atual.userVehicleId,
      status,
      updatedAt: atual.updatedAt,
    };
  }

  /**
   * Reenvio de uma foto reprovada: troca o arquivo, devolve a foto para
   * PENDENTE e a revistoria para EM_ANALISE. O e-mail aos analistas só sai
   * para o pedido que efetivamente trocou a foto.
   */
  async reenviarFoto(
    photoId: number,
    base64: string,
    usuario: UsuarioAutenticado,
    debugId?: string,
  ) {
    const foto = await this.fotos.comRevistoria(photoId);
    if (!foto) {
      throw new NotFoundException('Foto de revistoria não encontrada');
    }
    const { userVehicle } = foto.reinspection;
    exigirDonoOuAdmin(usuario, userVehicle.userId);

    if (foto.status !== ReinspectionPhotoStatus.REPROVADA) {
      throw new BadRequestException(MSG_SO_REPROVADA);
    }

    const novaUrl = await this.arquivos.uploadReinspectionPhotoFromBase64(
      base64,
      foto.nomeArquivo,
    );

    // Foto e revistoria mudam juntas, com a revistoria travada: a avaliação
    // do painel não decide com um retrato de antes do reenvio.
    const reinspectionStatus = await this.revistorias.comRevistoriaTravada(
      foto.reinspectionId,
      async (tx) => {
        const trocou = await this.fotos.marcarReenviada(foto.id, novaUrl, tx);
        if (!trocou) {
          // Outro reenvio da mesma foto ganhou: ela já não está reprovada.
          throw new BadRequestException(MSG_SO_REPROVADA);
        }
        const transicao = await this.revistorias.transicionar(
          foto.reinspectionId,
          ORIGENS.MARCAR_EM_ANALISE,
          ReinspectionStatus.EM_ANALISE,
          { repeticaoIdempotente: true, cliente: tx },
        );
        return transicao.status;
      },
    );

    const notificacao = await this.avisarAnalistas(
      photoId,
      userVehicle,
      novaUrl,
      debugId,
    );

    return {
      photoId: foto.id,
      reinspectionId: foto.reinspectionId,
      reinspectionStatus,
      photoStatus: ReinspectionPhotoStatus.PENDENTE,
      photoUrl: this.arquivos.buildUrl(novaUrl),
      // Campo aditivo.
      notificacao,
    };
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async veiculoDoUsuario(
    userVehicleId: number,
    usuario: UsuarioAutenticado,
  ) {
    const veiculo = await this.revistorias.veiculo(userVehicleId);
    if (!veiculo) {
      throw new NotFoundException('Veículo não encontrado');
    }
    exigirDonoOuAdmin(usuario, veiculo.userId);
    return veiculo;
  }

  private async avisarAnalistas(
    photoId: number,
    veiculo: { chassi: string; plate: string | null },
    novaUrl: string,
    debugId?: string,
  ): Promise<NotificacaoDoReenvio> {
    try {
      await this.mail.sendFotoRecusadaReenviadaEmail(
        veiculo.chassi,
        veiculo.plate,
        debugId,
        [novaUrl],
      );
      return 'ENVIADA';
    } catch (erro) {
      // A foto já foi trocada; a resposta segue 200 (contrato do app) e diz
      // que o aviso falhou.
      this.logger.error(
        debugLog(
          ReinspectionAndamentoService.name,
          'Falha ao enviar e-mail de foto reenviada',
          debugId,
          {
            photoId,
            error: erro instanceof Error ? erro.message : String(erro),
          },
        ),
      );
      return 'FALHOU';
    }
  }
}

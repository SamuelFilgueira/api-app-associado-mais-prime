import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ReinspectionStatus } from '@prisma/client';
import {
  UsuarioAutenticado,
  exigirDonoOuAdmin,
} from 'src/infra/auth/usuario-autenticado';
import { TravaService } from 'src/infra/redis/trava.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { ehRepeticaoDaAbertura } from 'src/reinspection/domain/revistoria-abertura';
import { fotoIncompleta } from 'src/reinspection/domain/revistoria-foto';
import { AddPhotosDto } from 'src/reinspection/dto/add-photos.dto';
import { CreateReinspectionDto } from 'src/reinspection/dto/create-reinspection.dto';
import {
  NovaFoto,
  ReinspectionPhotoRepository,
} from 'src/reinspection/repositories/reinspection-photo.repository';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';
import { debugLog } from 'src/shared/debug-log.util';
import { DomainError } from 'src/shared/erros/erros';

export const CODIGO_CRIACAO_EM_ANDAMENTO = 'REVISTORIA_CRIACAO_EM_ANDAMENTO';

/** Trava da criação: cobre uma leitura e um insert. */
const TRAVA_DA_CRIACAO_TTL_MS = 15_000;
const TRAVA_DA_CRIACAO_TENTATIVAS = 25;
const TRAVA_DA_CRIACAO_ESPERA_MS = 80;
const esperar = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Envio da revistoria pelo associado: abre a revistoria e recebe as fotos em
 * lotes (a submissão fica em `ReinspectionSubmissaoService`). O associado só
 * alcança revistoria de veículo dele; token ADMIN (painel) é isento.
 */
@Injectable()
export class ReinspectionEnvioService {
  private readonly logger = new Logger(ReinspectionEnvioService.name);

  constructor(
    private readonly revistorias: ReinspectionRepository,
    private readonly fotos: ReinspectionPhotoRepository,
    private readonly arquivos: FileUploadService,
    private readonly trava: TravaService,
  ) {}

  /**
   * Abre uma revistoria PENDENTE para o veículo.
   *
   * A criação roda sob trava por veículo: um segundo pedido idêntico que
   * chega junto (toque duplo, retry do cliente) recebe a MESMA revistoria em
   * vez de criar outra. Ver `ehRepeticaoDaAbertura`.
   */
  async criar(
    dto: CreateReinspectionDto,
    usuario: UsuarioAutenticado,
    debugId?: string,
  ) {
    const veiculo = await this.revistorias.veiculo(dto.userVehicleId);
    if (!veiculo) {
      this.logger.warn(
        debugLog(
          ReinspectionEnvioService.name,
          'Validação falhou no create: veículo não encontrado',
          debugId,
          { userVehicleId: dto.userVehicleId },
        ),
      );
      throw new NotFoundException('Veículo não encontrado');
    }
    exigirDonoOuAdmin(usuario, veiculo.userId);

    const revistoria = await this.comTravaDoVeiculo(veiculo.id, async () => {
      const ultima = await this.revistorias.ultimaDoVeiculo(veiculo.id);
      const repetida = ehRepeticaoDaAbertura(
        ultima && { ...ultima, totalFotos: ultima._count.photos },
        dto,
        new Date(),
      );
      if (ultima && repetida) return ultima;

      return this.revistorias.criar({
        userVehicleId: veiculo.id,
        vehicleType: dto.vehicleType,
        codigoVeiculo: dto.codigoVeiculo ?? null,
      });
    });

    return {
      reinspectionId: revistoria.id,
      status: revistoria.status,
      createdAt: revistoria.createdAt,
    };
  }

  /**
   * Adiciona um lote de fotos a uma revistoria PENDENTE. Pode ser chamado
   * várias vezes (envio incremental).
   */
  async adicionarFotos(
    reinspectionId: number,
    dto: AddPhotosDto,
    usuario: UsuarioAutenticado,
    debugId?: string,
  ) {
    const revistoria = await this.revistorias.comDono(reinspectionId);
    if (!revistoria) {
      throw new NotFoundException('Revistoria não encontrada');
    }
    exigirDonoOuAdmin(usuario, revistoria.userVehicle.userId);

    if (revistoria.status !== ReinspectionStatus.PENDENTE) {
      throw new BadRequestException(
        'Fotos só podem ser adicionadas a revistorias com status PENDENTE',
      );
    }
    if (dto.photos.some(fotoIncompleta)) {
      throw new BadRequestException(
        'Cada foto precisa informar nomeArquivo e binario',
      );
    }

    await this.fotos.adicionar(
      reinspectionId,
      await this.armazenar(reinspectionId, dto, debugId),
    );

    return {
      reinspectionId,
      photosAdded: dto.photos.length,
      totalPhotos: await this.fotos.contar(reinspectionId),
    };
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async armazenar(
    reinspectionId: number,
    dto: AddPhotosDto,
    debugId?: string,
  ): Promise<NovaFoto[]> {
    try {
      return await Promise.all(
        dto.photos.map(async (foto) => ({
          nomeArquivo: foto.nomeArquivo,
          codigoTipo: foto.codigoTipo,
          templatePhotoId: foto.templatePhotoId,
          url: await this.arquivos.uploadReinspectionPhotoFromBase64(
            foto.binario,
            foto.nomeArquivo,
          ),
        })),
      );
    } catch (erro) {
      this.logger.error(
        debugLog(
          ReinspectionEnvioService.name,
          'Falha ao salvar fotos',
          debugId,
          {
            reinspectionId,
            error: erro instanceof Error ? erro.message : String(erro),
          },
        ),
      );
      throw new BadRequestException(
        'Falha ao processar as fotos em base64 para armazenamento local',
      );
    }
  }

  /**
   * Uma criação por veículo de cada vez. A trava dura uma leitura e um
   * insert; quem chega junto espera alguns milissegundos e, ao entrar,
   * encontra a revistoria recém-criada.
   */
  private async comTravaDoVeiculo<T>(
    userVehicleId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    for (let i = 0; i < TRAVA_DA_CRIACAO_TENTATIVAS; i++) {
      const resultado = await this.trava.tentar(
        `revistoria-criar:${userVehicleId}`,
        TRAVA_DA_CRIACAO_TTL_MS,
        fn,
      );
      if (resultado.executou) return resultado.valor;
      await esperar(TRAVA_DA_CRIACAO_ESPERA_MS);
    }
    throw new DomainError(
      CODIGO_CRIACAO_EM_ANDAMENTO,
      'Já existe uma revistoria sendo aberta para este veículo. Aguarde alguns segundos e tente novamente.',
      { status: 409 },
    );
  }
}

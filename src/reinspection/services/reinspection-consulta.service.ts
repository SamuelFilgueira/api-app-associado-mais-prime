import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  UsuarioAutenticado,
  exigirDonoOuAdmin,
} from 'src/infra/auth/usuario-autenticado';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import {
  limiteDaListagem,
  termosDeBusca,
} from 'src/reinspection/domain/revistoria-foto';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';

/** Revistoria como vem do repositório, com o veículo aninhado. */
interface ComVeiculo {
  userVehicle: { chassi: string; plate: string | null };
}

/** Leva chassi e placa para o nível da revistoria (formato das listagens). */
function comChassiEPlaca<T extends ComVeiculo>({ userVehicle, ...resto }: T) {
  return { ...resto, chassi: userVehicle.chassi, plate: userVehicle.plate };
}

/** Leituras da revistoria: listagens do painel e consultas do app. */
@Injectable()
export class ReinspectionConsultaService {
  constructor(
    private readonly revistorias: ReinspectionRepository,
    private readonly fotos: ReinspectionPhotoRepository,
    private readonly arquivos: FileUploadService,
  ) {}

  // ── Painel ────────────────────────────────────────────────────────────────

  totais() {
    return this.revistorias.totais();
  }

  async listarTodas() {
    return (await this.revistorias.listar()).map(comChassiEPlaca);
  }

  async listarRecentes(limite?: number) {
    const revistorias = await this.revistorias.listar(limiteDaListagem(limite));
    return revistorias.map(comChassiEPlaca);
  }

  async buscarPorChassiOuPlaca(chassi?: string, plate?: string) {
    const termos = termosDeBusca(chassi, plate);
    if (!termos) {
      throw new BadRequestException(
        'Informe ao menos um parâmetro de busca: chassi ou plate',
      );
    }
    return (await this.revistorias.buscarPorVeiculo(termos)).map(
      comChassiEPlaca,
    );
  }

  /** Detalhe de uma revistoria pelo id. */
  async detalhe(reinspectionId: number) {
    const revistoria = await this.revistorias.detalhe(reinspectionId);
    if (!revistoria) {
      throw new NotFoundException('Revistoria não encontrada');
    }
    return comChassiEPlaca(revistoria);
  }

  async fotosDaRevistoria(reinspectionId: number) {
    const revistoria = await this.revistorias.comDono(reinspectionId);
    if (!revistoria) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    const fotos = await this.fotos.listarDaRevistoria(reinspectionId);
    return {
      reinspectionId,
      chassi: revistoria.userVehicle.chassi,
      plate: revistoria.userVehicle.plate,
      totalPhotos: fotos.length,
      photos: fotos.map((foto) => ({
        ...foto,
        url: this.arquivos.buildUrl(foto.url),
      })),
    };
  }

  // ── App (e painel, isento da posse) ───────────────────────────────────────

  /** Status da última revistoria do veículo. */
  async statusDoVeiculo(userVehicleId: number, usuario: UsuarioAutenticado) {
    const veiculo = await this.veiculoDoUsuario(userVehicleId, usuario);
    const base = {
      userVehicleId,
      chassi: veiculo.chassi,
      plate: veiculo.plate,
    };

    const ultima = await this.revistorias.ultimaDoVeiculo(userVehicleId);
    if (!ultima) {
      return { ...base, hasReinspection: false, status: null };
    }
    return {
      ...base,
      hasReinspection: true,
      reinspectionId: ultima.id,
      status: ultima.status,
      createdAt: ultima.createdAt,
      updatedAt: ultima.updatedAt,
    };
  }

  /** Fotos reprovadas da última revistoria, com o template de cada uma. */
  async fotosReprovadas(userVehicleId: number, usuario: UsuarioAutenticado) {
    const veiculo = await this.veiculoDoUsuario(userVehicleId, usuario);

    const ultima = await this.revistorias.ultimaDoVeiculo(userVehicleId);
    if (!ultima) {
      throw new NotFoundException(
        'Nenhuma revistoria encontrada para este veículo',
      );
    }

    const reprovadas = await this.fotos.listarReprovadas(ultima.id);
    const url = (caminho?: string | null) => this.arquivos.buildUrl(caminho);

    return {
      reinspectionId: ultima.id,
      chassi: veiculo.chassi,
      plate: veiculo.plate,
      reinspectionStatus: ultima.status,
      rejectedPhotos: reprovadas.map((foto) => ({
        photoId: foto.id,
        photoUrl: url(foto.url),
        templatePhotoId: foto.templatePhotoId,
        templatePhotoUrl: url(foto.templatePhoto?.photoUrl ?? null),
        ordem: foto.templatePhoto?.ordem ?? null,
        templatePhoto: foto.templatePhoto
          ? {
              id: foto.templatePhoto.id,
              vehicleType: foto.templatePhoto.vehicleType,
              ordem: foto.templatePhoto.ordem,
              photoUrl: url(foto.templatePhoto.photoUrl),
            }
          : null,
      })),
    };
  }

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
}

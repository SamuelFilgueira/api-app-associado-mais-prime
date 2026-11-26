import { Injectable } from '@nestjs/common';
import { UsuarioAutenticado } from 'src/infra/auth/usuario-autenticado';
import { AddPhotosDto } from 'src/reinspection/dto/add-photos.dto';
import { CreateReinspectionDto } from 'src/reinspection/dto/create-reinspection.dto';
import { UpsertTemplatePhotoDto } from 'src/reinspection/dto/upsert-template-photo.dto';
import { ReinspectionAndamentoService } from 'src/reinspection/services/reinspection-andamento.service';
import {
  ReinspectionActor,
  ReinspectionAprovacaoService,
} from 'src/reinspection/services/reinspection-aprovacao.service';
import { ReinspectionAvaliacaoService } from 'src/reinspection/services/reinspection-avaliacao.service';
import { ReinspectionConsultaService } from 'src/reinspection/services/reinspection-consulta.service';
import { ReinspectionEnvioService } from 'src/reinspection/services/reinspection-envio.service';
import { ReinspectionSubmissaoService } from 'src/reinspection/services/reinspection-submissao.service';
import { ReinspectionTemplateService } from 'src/reinspection/services/reinspection-template.service';

export type { ReinspectionActor };

/**
 * Fachada da revistoria: o controller fala só com ela. NÃO tem regra — cada
 * método delega a um caso de uso:
 *
 * | Caso de uso                    | Operações                                   |
 * |--------------------------------|---------------------------------------------|
 * | `ReinspectionEnvioService`     | abrir, adicionar fotos (app)                |
 * | `ReinspectionSubmissaoService` | submeter para análise (app)                 |
 * | `ReinspectionAndamentoService` | EM_ANALISE, reenviar foto, finalizar (app)  |
 * | `ReinspectionAvaliacaoService` | aprovar/reprovar foto (painel)              |
 * | `ReinspectionAprovacaoService` | aprovar revistoria, boleto manual (painel)  |
 * | `ReinspectionConsultaService`  | listagens, detalhe, status, reprovadas      |
 * | `ReinspectionTemplateService`  | fotos de template                           |
 *
 * Regra nova nasce no caso de uso (ou em `domain/`), nunca aqui.
 */
@Injectable()
export class ReinspectionService {
  constructor(
    private readonly envio: ReinspectionEnvioService,
    private readonly submissao: ReinspectionSubmissaoService,
    private readonly andamento: ReinspectionAndamentoService,
    private readonly avaliacao: ReinspectionAvaliacaoService,
    private readonly aprovacao: ReinspectionAprovacaoService,
    private readonly consulta: ReinspectionConsultaService,
    private readonly templates: ReinspectionTemplateService,
  ) {}

  // ── App ───────────────────────────────────────────────────────────────────

  create(
    dto: CreateReinspectionDto,
    usuario: UsuarioAutenticado,
    debugId?: string,
  ) {
    return this.envio.criar(dto, usuario, debugId);
  }

  addPhotos(
    reinspectionId: number,
    dto: AddPhotosDto,
    usuario: UsuarioAutenticado,
    debugId?: string,
  ) {
    return this.envio.adicionarFotos(reinspectionId, dto, usuario, debugId);
  }

  submitReinspection(
    reinspectionId: number,
    usuario: UsuarioAutenticado,
    debugId?: string,
  ) {
    return this.submissao.submeter(reinspectionId, usuario, debugId);
  }

  getStatusByUserVehicleId(userVehicleId: number, usuario: UsuarioAutenticado) {
    return this.consulta.statusDoVeiculo(userVehicleId, usuario);
  }

  updateStatusByUserVehicleId(
    userVehicleId: number,
    usuario: UsuarioAutenticado,
  ) {
    return this.andamento.marcarEmAnalise(userVehicleId, usuario);
  }

  finalizeByUserVehicleId(userVehicleId: number, usuario: UsuarioAutenticado) {
    return this.andamento.finalizar(userVehicleId, usuario);
  }

  getRejectedPhotos(userVehicleId: number, usuario: UsuarioAutenticado) {
    return this.consulta.fotosReprovadas(userVehicleId, usuario);
  }

  resendPhoto(
    photoId: number,
    base64: string,
    usuario: UsuarioAutenticado,
    debugId?: string,
  ) {
    return this.andamento.reenviarFoto(photoId, base64, usuario, debugId);
  }

  // ── Painel ────────────────────────────────────────────────────────────────

  getDashboardTotals() {
    return this.consulta.totais();
  }

  listAll() {
    return this.consulta.listarTodas();
  }

  listRecent(limit?: number) {
    return this.consulta.listarRecentes(limit);
  }

  searchByChassiOrPlate(chassi?: string, plate?: string) {
    return this.consulta.buscarPorChassiOuPlaca(chassi, plate);
  }

  getById(reinspectionId: number) {
    return this.consulta.detalhe(reinspectionId);
  }

  getPhotosByReinspectionId(reinspectionId: number) {
    return this.consulta.fotosDaRevistoria(reinspectionId);
  }

  approveByUserVehicleId(
    userVehicleId: number,
    debugId?: string,
    ator?: ReinspectionActor,
  ) {
    return this.aprovacao.aprovar(userVehicleId, debugId, ator);
  }

  gerarBoleto(reinspectionId: number, debugId?: string) {
    return this.aprovacao.gerarBoleto(reinspectionId, debugId);
  }

  reprovePhoto(photoId: number) {
    return this.avaliacao.reprovarFoto(photoId);
  }

  approvePhoto(photoId: number) {
    return this.avaliacao.aprovarFoto(photoId);
  }

  // ── Templates (app e painel) ──────────────────────────────────────────────

  upsertTemplatePhoto(dto: UpsertTemplatePhotoDto, file: Express.Multer.File) {
    return this.templates.salvar(dto, file);
  }

  getTemplatePhotos(vehicleType?: string) {
    return this.templates.listar(vehicleType);
  }
}

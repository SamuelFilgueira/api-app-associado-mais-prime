import { ConflictException } from '@nestjs/common';
import { UsuarioAutenticado } from 'src/infra/auth/usuario-autenticado';
import {
  IdempotenciaService,
  OperacaoIdempotente,
} from 'src/infra/idempotencia/idempotencia.service';
import { MailService } from 'src/infra/mail/mail.service';
import { ResultadoDaTrava, TravaService } from 'src/infra/redis/trava.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';
import { AddPhotosDto } from 'src/reinspection/dto/add-photos.dto';
import { CreateReinspectionDto } from 'src/reinspection/dto/create-reinspection.dto';
import { UpsertTemplatePhotoDto } from 'src/reinspection/dto/upsert-template-photo.dto';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';
import { ReinspectionAndamentoService } from 'src/reinspection/services/reinspection-andamento.service';
import {
  ReinspectionActor,
  ReinspectionAprovacaoService,
} from 'src/reinspection/services/reinspection-aprovacao.service';
import { ReinspectionAvaliacaoService } from 'src/reinspection/services/reinspection-avaliacao.service';
import { ReinspectionConsultaService } from 'src/reinspection/services/reinspection-consulta.service';
import { ReinspectionEnvioService } from 'src/reinspection/services/reinspection-envio.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { ReinspectionService } from 'src/reinspection/services/reinspection.service';
import { ReinspectionSubmissaoService } from 'src/reinspection/services/reinspection-submissao.service';
import { ReinspectionTemplateService } from 'src/reinspection/services/reinspection-template.service';
import { PrismaRevistoriaMemoria } from 'src/reinspection/testing/prisma-revistoria.memoria';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';

/** Token do painel: isento da checagem de posse, como nas rotas reais. */
export const USUARIO_DO_PAINEL: UsuarioAutenticado = {
  userId: 9_000,
  role: 'ADMIN',
  adminRole: 'REVISTORIA',
};

/** Trava em memória com o mesmo contrato do `TravaService` (sem espera). */
export class TravaEmMemoria {
  private readonly ocupadas = new Set<string>();

  async tentar<T>(
    chave: string,
    _ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<ResultadoDaTrava<T>> {
    if (this.ocupadas.has(chave)) return { executou: false };
    this.ocupadas.add(chave);
    try {
      return { executou: true, valor: await fn() };
    } finally {
      this.ocupadas.delete(chave);
    }
  }
}

/**
 * Idempotência em memória com o contrato do `IdempotenciaService`: a
 * primeira chamada executa; a repetição recebe a resposta gravada; a que
 * chega no meio recebe 409 `OPERACAO_EM_ANDAMENTO`; falha libera a chave.
 */
export class IdempotenciaEmMemoria {
  private readonly chaves = new Map<
    string,
    { concluida: boolean; resposta?: unknown }
  >();

  async executar<T>(
    pedido: OperacaoIdempotente,
    operacao: () => Promise<T>,
  ): Promise<T> {
    const chave = `${pedido.userId}|${pedido.escopo}|${pedido.chave}`;
    const existente = this.chaves.get(chave);
    if (existente?.concluida) return existente.resposta as T;
    if (existente) {
      throw new ConflictException({
        statusCode: 409,
        code: 'OPERACAO_EM_ANDAMENTO',
        message: 'Esta operação já está sendo processada.',
      });
    }

    this.chaves.set(chave, { concluida: false });
    try {
      const resposta = await operacao();
      this.chaves.set(chave, { concluida: true, resposta });
      return resposta;
    } catch (erro) {
      this.chaves.delete(chave);
      throw erro;
    }
  }
}

/**
 * Monta o `ReinspectionService` (fachada + casos de uso + repositórios
 * reais) sobre o Prisma em memória, com dublês dos colaboradores externos
 * (e-mail, upload, boleto, envio à Hinova, trava e idempotência).
 *
 * Os specs falam com `sujeito`, que tem a mesma forma das chamadas do
 * controller. Mudou a construção do service? Ajusta-se AQUI; as expectativas
 * dos specs de caracterização ficam como estão.
 *
 * `sujeito` age como o painel (isento de posse); `comoUsuario(u)` devolve o
 * mesmo conjunto de operações em nome de outro usuário.
 */
export function montarReinspection() {
  const banco = new PrismaRevistoriaMemoria();

  const mail = {
    sendRevistoriaEmail: jest.fn().mockResolvedValue(undefined),
    sendFotoRecusadaReenviadaEmail: jest.fn().mockResolvedValue(undefined),
  };

  let arquivos = 0;
  const upload = {
    uploadReinspectionPhotoFromBase64: jest
      .fn()
      .mockImplementation((_binario: string, nome: string) =>
        Promise.resolve(`uploads/reinspection-photos/${++arquivos}-${nome}`),
      ),
    uploadReinspectionTemplatePhoto: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(`uploads/reinspection-templates/${++arquivos}.jpg`),
      ),
    deleteReinspectionTemplatePhoto: jest.fn().mockResolvedValue(undefined),
    buildUrl: jest
      .fn()
      .mockImplementation((caminho: string | null | undefined) =>
        caminho ? `https://api.teste/${caminho}` : null,
      ),
  };

  const boleto = {
    processar: jest.fn().mockResolvedValue({
      status: 'GERADO',
      nossoNumero: '123',
      tentativas: 1,
      proximaTentativaEm: null,
      erro: null,
      pulado: false,
    }),
  };

  const hinova = {
    enviarFotos: jest.fn().mockResolvedValue({
      envioId: 1,
      status: 'ENVIADA',
      totalFotos: 1,
      totalInseridas: 1,
      totalFalhas: 0,
    }),
  };

  const trava = new TravaEmMemoria();
  const idempotencia = new IdempotenciaEmMemoria();

  const revistorias = new ReinspectionRepository(banco.comoPrisma());
  const fotos = new ReinspectionPhotoRepository(banco.comoPrisma());
  const arquivosService = upload as unknown as FileUploadService;
  const mailService = mail as unknown as MailService;

  const service = new ReinspectionService(
    new ReinspectionEnvioService(
      revistorias,
      fotos,
      arquivosService,
      trava as unknown as TravaService,
    ),
    new ReinspectionSubmissaoService(
      revistorias,
      mailService,
      idempotencia as unknown as IdempotenciaService,
    ),
    new ReinspectionAndamentoService(
      revistorias,
      fotos,
      arquivosService,
      mailService,
    ),
    new ReinspectionAvaliacaoService(revistorias, fotos),
    new ReinspectionAprovacaoService(
      revistorias,
      fotos,
      hinova as unknown as ReinspectionHinovaService,
      boleto as unknown as BoletoReativacaoService,
    ),
    new ReinspectionConsultaService(revistorias, fotos, arquivosService),
    new ReinspectionTemplateService(fotos, arquivosService),
  );

  const comoUsuario = (usuario: UsuarioAutenticado) => ({
    create: (dto: CreateReinspectionDto, debugId?: string) =>
      service.create(dto, usuario, debugId),
    addPhotos: (id: number, dto: AddPhotosDto, debugId?: string) =>
      service.addPhotos(id, dto, usuario, debugId),
    submit: (id: number, debugId?: string) =>
      service.submitReinspection(id, usuario, debugId),
    getStatus: (userVehicleId: number) =>
      service.getStatusByUserVehicleId(userVehicleId, usuario),
    marcarEmAnalise: (userVehicleId: number) =>
      service.updateStatusByUserVehicleId(userVehicleId, usuario),
    finalizar: (userVehicleId: number) =>
      service.finalizeByUserVehicleId(userVehicleId, usuario),
    getRejectedPhotos: (userVehicleId: number) =>
      service.getRejectedPhotos(userVehicleId, usuario),
    resendPhoto: (photoId: number, base64: string, debugId?: string) =>
      service.resendPhoto(photoId, base64, usuario, debugId),
    aprovar: (
      userVehicleId: number,
      debugId?: string,
      ator?: ReinspectionActor,
    ) => service.approveByUserVehicleId(userVehicleId, debugId, ator),
    gerarBoleto: (id: number, debugId?: string) =>
      service.gerarBoleto(id, debugId),
    reprovePhoto: (photoId: number) => service.reprovePhoto(photoId),
    approvePhoto: (photoId: number) => service.approvePhoto(photoId),
    listRecent: (limit?: number) => service.listRecent(limit),
    listAll: () => service.listAll(),
    search: (chassi?: string, plate?: string) =>
      service.searchByChassiOrPlate(chassi, plate),
    getById: (id: number) => service.getById(id),
    getPhotos: (id: number) => service.getPhotosByReinspectionId(id),
    getDashboardTotals: () => service.getDashboardTotals(),
    upsertTemplatePhoto: (dto: UpsertTemplatePhotoDto, file: unknown) =>
      service.upsertTemplatePhoto(dto, file as Express.Multer.File),
    getTemplatePhotos: (vehicleType?: string) =>
      service.getTemplatePhotos(vehicleType),
  });

  return {
    banco,
    mail,
    upload,
    boleto,
    hinova,
    trava,
    idempotencia,
    service,
    sujeito: comoUsuario(USUARIO_DO_PAINEL),
    comoUsuario,
  };
}

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ReinspectionHinovaEnvioOrigem,
  ReinspectionHinovaEnvioStatus,
  ReinspectionStatus,
} from '@prisma/client';
import {
  CODIGO_ENVIO_EM_ANDAMENTO,
  FotoParaEnvio,
  ResultadoEnvioFoto,
  selecionarFotos,
  statusDoEnvio,
} from 'src/reinspection/domain/hinova-envio';
import { ReinspectionHinovaRepository } from 'src/reinspection/repositories/reinspection-hinova.repository';
import {
  ReinspectionHinovaLoteService,
  RevistoriaParaEnvio,
} from 'src/reinspection/services/reinspection-hinova-lote.service';
import { DomainError } from 'src/shared/erros/erros';
import { baseTag } from 'src/shared/log.util';
import { debugLog } from 'src/shared/debug-log.util';
import { exigirBase } from 'src/shared/tenant/tenant-context';

export type { ResultadoEnvioFoto };

/**
 * Validade do lease do envio. Cobre a pior execução (login na Hinova + duas
 * tentativas de 60 s + gravação); se o processo morrer no meio, o reenvio
 * manual volta a ser aceito depois desse prazo.
 */
const LEASE_DO_ENVIO_MS = 5 * 60_000;

export interface EnviarFotosOpcoes {
  origem: ReinspectionHinovaEnvioOrigem;
  /** Quem disparou (token do painel). */
  adminPanelUserId?: number;
  adminPanelUserEmail?: string;
  /** Restringe o envio a estas fotos (precisam pertencer à revistoria). */
  photoIds?: number[];
  /** Inclui fotos já marcadas como enviadas (`sentToHinova = true`). */
  forcar?: boolean;
  debugId?: string;
}

export interface ResultadoEnvioFotos {
  envioId: number | null;
  reinspectionId: number;
  status: ReinspectionHinovaEnvioStatus;
  hinovaEnvioStatus: ReinspectionHinovaEnvioStatus;
  totalFotos: number;
  totalInseridas: number;
  totalFalhas: number;
  httpStatus: number | null;
  errorMessage: string | null;
  fotos: ResultadoEnvioFoto[];
}

/**
 * Envio das fotos de revistoria à Hinova (`POST /veiculo/foto/cadastrar`).
 *
 * Um envio por vez por revistoria: antes de ler as fotos pendentes e de
 * qualquer HTTP, a execução reivindica o lease `hinovaEnvioLeaseAte`. Quem
 * não ganha não envia (caminho automático) ou recebe 409 (reenvio manual).
 *
 * Toda tentativa gera uma linha em `ReinspectionHinovaEnvio`, inclusive
 * quando a falha acontece antes do HTTP (arquivo local ausente, login na
 * Hinova indisponível, timeout). Falha de infraestrutura da Hinova não é
 * propagada: o resultado volta com `status = FALHA` e o chamador decide.
 * Lançam exceção: validação (revistoria/foto inexistente, estado inválido),
 * base do associado não resolvida e envio simultâneo no reenvio manual.
 */
@Injectable()
export class ReinspectionHinovaService {
  private readonly logger = new Logger(ReinspectionHinovaService.name);

  constructor(
    private readonly repositorio: ReinspectionHinovaRepository,
    private readonly lote: ReinspectionHinovaLoteService,
  ) {}

  /**
   * Envia fotos da revistoria à Hinova e persiste o resultado.
   * Retorna `null` quando não há foto a enviar ou, no caminho automático,
   * quando outro envio da mesma revistoria está em andamento (nada é
   * registrado nos dois casos).
   */
  async enviarFotos(
    reinspectionId: number,
    opcoes: EnviarFotosOpcoes,
  ): Promise<ResultadoEnvioFotos | null> {
    const revistoria = await this.repositorio.paraEnvio(reinspectionId);
    if (!revistoria) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    const manual =
      opcoes.origem === ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL;
    if (
      manual &&
      revistoria.status !== ReinspectionStatus.APROVADA &&
      revistoria.status !== ReinspectionStatus.FINALIZADA
    ) {
      throw new BadRequestException(
        'Somente revistorias APROVADA ou FINALIZADA podem ter fotos reenviadas à Hinova',
      );
    }

    // Prévia sem lease: valida `photoIds` e evita reivindicar à toa.
    const previa = await this.fotosDoEnvio(reinspectionId, opcoes);
    if (previa.length === 0) return null;

    // Base do dono do veículo; sem ela não há chamada (antes saía com a
    // credencial da base padrão do deploy).
    const baseOrigin = exigirBase(
      revistoria.baseOrigin,
      'envio de fotos da revistoria à Hinova',
    );

    const lease = await this.repositorio.reivindicarLease(
      reinspectionId,
      new Date(),
      LEASE_DO_ENVIO_MS,
    );
    if (!lease) {
      if (manual) {
        throw new DomainError(
          CODIGO_ENVIO_EM_ANDAMENTO,
          'Já existe um envio de fotos à Hinova em andamento para esta revistoria. Aguarde a conclusão e tente novamente.',
          { status: 409 },
        );
      }
      this.logger.warn(
        `${baseTag(baseOrigin)} ${debugLog(ReinspectionHinovaService.name, 'Envio à Hinova já em andamento; esta execução não envia', opcoes.debugId, { reinspectionId, origem: opcoes.origem })}`,
      );
      return null;
    }

    try {
      // A lista que vale é a lida COM o lease: o envio anterior já marcou o
      // que a Hinova confirmou.
      const fotos = await this.fotosDoEnvio(reinspectionId, opcoes);
      if (fotos.length === 0) return null;
      return await this.enviar(revistoria, baseOrigin, fotos, opcoes);
    } finally {
      await this.repositorio.soltarLease(reinspectionId, lease);
    }
  }

  /** Reenvio manual do painel, já no formato de resposta da rota. */
  async reenviar(
    reinspectionId: number,
    opcoes: Omit<EnviarFotosOpcoes, 'origem'>,
  ) {
    const resultado = await this.enviarFotos(reinspectionId, {
      ...opcoes,
      origem: ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL,
    });
    if (resultado) return resultado;

    return {
      reinspectionId,
      envioId: null,
      status: null,
      totalFotos: 0,
      totalInseridas: 0,
      totalFalhas: 0,
      fotos: [],
      mensagem:
        'Nenhuma foto pendente de envio. Use forcar=true para reenviar fotos já inseridas.',
    };
  }

  /** Revistorias aprovadas/finalizadas com fotos ainda não inseridas na Hinova. */
  async listarPendentes() {
    const revistorias = await this.repositorio.listarPendentes();

    return revistorias.map(({ userVehicle, photos, _count, ...r }) => ({
      ...r,
      chassi: userVehicle.chassi,
      plate: userVehicle.plate,
      totalFotos: _count.photos,
      totalFotosPendentes: photos.length,
      totalTentativas: _count.hinovaEnvios,
      ultimoErro:
        photos.find((p) => p.hinovaUltimoErro)?.hinovaUltimoErro ?? null,
    }));
  }

  /** Histórico de tentativas de envio de uma revistoria. */
  async listarEnvios(reinspectionId: number) {
    const revistoria = await this.repositorio.consolidado(reinspectionId);
    if (!revistoria) {
      throw new NotFoundException('Revistoria não encontrada');
    }
    const envios = await this.repositorio.envios(reinspectionId);
    return { ...revistoria, envios };
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async fotosDoEnvio(
    reinspectionId: number,
    opcoes: EnviarFotosOpcoes,
  ): Promise<FotoParaEnvio[]> {
    const selecao = selecionarFotos(
      await this.repositorio.fotos(reinspectionId),
      opcoes,
    );
    if (!selecao.ok) {
      throw new BadRequestException(
        'Uma ou mais fotos informadas não pertencem a esta revistoria',
      );
    }
    return selecao.fotos;
  }

  private async enviar(
    revistoria: RevistoriaParaEnvio,
    baseOrigin: string,
    fotos: FotoParaEnvio[],
    opcoes: EnviarFotosOpcoes,
  ): Promise<ResultadoEnvioFotos> {
    const inicio = Date.now();

    // 1) e 2) Leitura dos arquivos e chamada à Hinova.
    const { resultados, chamada } = await this.lote.postar(
      revistoria,
      baseOrigin,
      fotos,
    );

    // 3) Persistência (fotos, log da tentativa, consolidado da revistoria).
    const fotosResultado = resultados;
    const totalInseridas = fotosResultado.filter((f) => f.inserida).length;
    const totalFalhas = fotosResultado.length - totalInseridas;
    const status = statusDoEnvio(fotosResultado.length, totalInseridas);

    const { envioId, hinovaEnvioStatus } =
      await this.repositorio.registrarTentativa({
        reinspectionId: revistoria.id,
        origem: opcoes.origem,
        status,
        baseOrigin,
        codigoVeiculo: revistoria.codigoVeiculo,
        adminPanelUserId: opcoes.adminPanelUserId,
        adminPanelUserEmail: opcoes.adminPanelUserEmail,
        fotos: fotosResultado,
        totalInseridas,
        httpStatus: chamada.httpStatus,
        responseBody: chamada.responseBody,
        errorMessage: chamada.errorMessage,
        duracaoMs: Date.now() - inicio,
        agora: new Date(),
      });

    const meta = {
      reinspectionId: revistoria.id,
      envioId,
      origem: opcoes.origem,
      status,
      totalFotos: fotosResultado.length,
      totalInseridas,
      totalFalhas,
      httpStatus: chamada.httpStatus,
      duracaoMs: Date.now() - inicio,
      adminPanelUserId: opcoes.adminPanelUserId ?? null,
      ...(chamada.errorMessage ? { errorMessage: chamada.errorMessage } : {}),
    };
    const linha = `${baseTag(baseOrigin)} ${debugLog(ReinspectionHinovaService.name, 'Envio de fotos de revistoria à Hinova', opcoes.debugId, meta)}`;
    if (status === ReinspectionHinovaEnvioStatus.ENVIADA) {
      this.logger.log(linha);
    } else {
      this.logger.error(linha);
    }

    return {
      envioId,
      reinspectionId: revistoria.id,
      status,
      hinovaEnvioStatus,
      totalFotos: fotosResultado.length,
      totalInseridas,
      totalFalhas,
      httpStatus: chamada.httpStatus,
      errorMessage: chamada.errorMessage,
      fotos: fotosResultado,
    };
  }
}

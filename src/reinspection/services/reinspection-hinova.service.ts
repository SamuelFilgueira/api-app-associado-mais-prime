import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  Prisma,
  ReinspectionHinovaEnvioOrigem,
  ReinspectionHinovaEnvioStatus,
  ReinspectionStatus,
} from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { TENANT } from 'src/config/tenant.config';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { baseTag } from 'src/shared/log.util';
import { debugLog } from 'src/shared/debug-log.util';

/** Timeout da chamada `/veiculo/foto/cadastrar` (payload grande, Hinova lenta). */
const HINOVA_FOTO_TIMEOUT_MS = 60_000;
/** Limite do corpo de resposta persistido no log. */
const RESPONSE_BODY_MAX_CHARS = 8_000;
const ERRO_MAX_CHARS = 500;
const SITUACAO_INSERIDO = 'Inserido';

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

export interface ResultadoEnvioFoto {
  photoId: number;
  nomeArquivo: string;
  inserida: boolean;
  situacao: string | null;
  erro: string | null;
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

interface FotoSelecionada {
  id: number;
  nomeArquivo: string;
  codigoTipo: number | null;
  url: string | null;
  sentToHinova: boolean;
}

interface FotoLida extends FotoSelecionada {
  binario: string;
}

interface RetornoHinovaFoto {
  nome_arquivo?: string;
  situacao?: string;
}

/**
 * Envio das fotos de revistoria à Hinova (`POST /veiculo/foto/cadastrar`).
 *
 * Toda tentativa gera uma linha em `ReinspectionHinovaEnvio`, inclusive
 * quando a falha acontece antes do HTTP (arquivo local ausente, login na
 * Hinova indisponível, timeout). Erros de infraestrutura nunca são
 * propagados: o resultado volta com `status = FALHA` e o chamador decide.
 * Só erros de validação (revistoria/foto inexistente, estado inválido)
 * lançam exceção HTTP.
 */
@Injectable()
export class ReinspectionHinovaService {
  private readonly logger = new Logger(ReinspectionHinovaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sgaAuthService: SgaAuthService,
  ) {}

  /**
   * Envia fotos da revistoria à Hinova e persiste o resultado.
   * Retorna `null` quando não há foto a enviar (nada é registrado).
   */
  async enviarFotos(
    reinspectionId: number,
    opcoes: EnviarFotosOpcoes,
  ): Promise<ResultadoEnvioFotos | null> {
    const reinspection = await this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: {
        id: true,
        status: true,
        codigoVeiculo: true,
        userVehicle: {
          select: { user: { select: { baseOrigin: true } } },
        },
        photos: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            nomeArquivo: true,
            codigoTipo: true,
            url: true,
            sentToHinova: true,
          },
        },
      },
    });

    if (!reinspection) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    if (
      opcoes.origem === ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL &&
      reinspection.status !== ReinspectionStatus.APROVADA &&
      reinspection.status !== ReinspectionStatus.FINALIZADA
    ) {
      throw new BadRequestException(
        'Somente revistorias APROVADA ou FINALIZADA podem ter fotos reenviadas à Hinova',
      );
    }

    const fotos = this.selecionarFotos(reinspection.photos, opcoes);
    if (fotos.length === 0) {
      return null;
    }

    const baseOrigin: BaseOrigin =
      reinspection.userVehicle?.user?.baseOrigin ?? TENANT.defaultBase;
    const inicio = Date.now();
    const resultados = new Map<number, ResultadoEnvioFoto>();
    for (const foto of fotos) {
      resultados.set(foto.id, {
        photoId: foto.id,
        nomeArquivo: foto.nomeArquivo,
        inserida: false,
        situacao: null,
        erro: null,
      });
    }

    // 1) Leitura dos arquivos locais — uma foto ausente não derruba as demais.
    const lidas: FotoLida[] = [];
    for (const foto of fotos) {
      try {
        lidas.push({ ...foto, binario: await this.lerBase64(foto.url) });
      } catch (error) {
        resultados.get(foto.id)!.erro = this.mensagem(error);
      }
    }

    let httpStatus: number | null = null;
    let responseBody: Prisma.InputJsonValue | undefined;
    let errorMessage: string | null = null;

    if (lidas.length === 0) {
      errorMessage = 'Nenhuma foto pôde ser lida do armazenamento local';
    } else {
      // 2) Chamada à Hinova.
      const payload: Record<string, unknown> = {
        foto: lidas.map((foto) => ({
          nome_arquivo: foto.nomeArquivo,
          ...(foto.codigoTipo != null ? { codigo_tipo: foto.codigoTipo } : {}),
          binario: foto.binario,
        })),
      };
      if (reinspection.codigoVeiculo != null) {
        payload.codigo_veiculo = reinspection.codigoVeiculo;
      }

      try {
        const response =
          await this.sgaAuthService.executeRequestWithAuth<unknown>(
            baseOrigin,
            {
              method: 'POST',
              url: `${SGA_BASE_URL}/veiculo/foto/cadastrar`,
              data: payload,
              headers: { 'Content-Type': 'application/json' },
              timeout: HINOVA_FOTO_TIMEOUT_MS,
              validateStatus: () => true,
            },
          );

        httpStatus = response.status;
        responseBody = this.resumirResposta(response.data);

        if (response.status >= 400 || !Array.isArray(response.data)) {
          errorMessage = this.truncar(
            `Hinova respondeu HTTP ${response.status}: ${this.textoResposta(response.data)}`,
            ERRO_MAX_CHARS,
          );
          for (const foto of lidas) {
            resultados.get(foto.id)!.erro = errorMessage;
          }
        } else {
          this.aplicarRetorno(
            lidas,
            response.data as RetornoHinovaFoto[],
            resultados,
          );
        }
      } catch (error) {
        errorMessage = this.truncar(
          `Falha na chamada à Hinova: ${this.mensagem(error)}`,
          ERRO_MAX_CHARS,
        );
        for (const foto of lidas) {
          resultados.get(foto.id)!.erro = errorMessage;
        }
      }
    }

    // 3) Persistência (fotos, log da tentativa, consolidado da revistoria).
    const fotosResultado = Array.from(resultados.values());
    const totalInseridas = fotosResultado.filter((f) => f.inserida).length;
    const totalFalhas = fotosResultado.length - totalInseridas;
    const statusTentativa = this.statusDaTentativa(
      fotosResultado.length,
      totalInseridas,
    );
    const agora = new Date();

    await this.prisma.$transaction(
      fotosResultado.map((foto) =>
        this.prisma.reinspectionPhoto.update({
          where: { id: foto.photoId },
          data: {
            hinovaTentativas: { increment: 1 },
            ...(foto.inserida
              ? {
                  sentToHinova: true,
                  hinovaSituacao: this.truncar(foto.situacao, 50),
                  hinovaEnviadaEm: agora,
                  hinovaUltimoErro: null,
                }
              : {
                  ...(foto.situacao != null
                    ? { hinovaSituacao: this.truncar(foto.situacao, 50) }
                    : {}),
                  hinovaUltimoErro: this.truncar(foto.erro, ERRO_MAX_CHARS),
                }),
          },
        }),
      ),
    );

    const envio = await this.prisma.reinspectionHinovaEnvio.create({
      data: {
        reinspectionId: reinspection.id,
        origem: opcoes.origem,
        status: statusTentativa,
        baseOrigin,
        codigoVeiculo: reinspection.codigoVeiculo,
        adminPanelUserId: opcoes.adminPanelUserId ?? null,
        adminPanelUserEmail: opcoes.adminPanelUserEmail ?? null,
        totalFotos: fotosResultado.length,
        totalInseridas,
        totalFalhas,
        photoIds: fotosResultado.map((f) => f.photoId),
        httpStatus,
        responseBody: responseBody ?? Prisma.JsonNull,
        errorMessage,
        duracaoMs: Date.now() - inicio,
      },
      select: { id: true },
    });

    const hinovaEnvioStatus = await this.consolidarRevistoria(
      reinspection.id,
      agora,
    );

    const meta = {
      reinspectionId: reinspection.id,
      envioId: envio.id,
      origem: opcoes.origem,
      status: statusTentativa,
      totalFotos: fotosResultado.length,
      totalInseridas,
      totalFalhas,
      httpStatus,
      duracaoMs: Date.now() - inicio,
      adminPanelUserId: opcoes.adminPanelUserId ?? null,
      ...(errorMessage ? { errorMessage } : {}),
    };
    const linha = `${baseTag(baseOrigin)} ${debugLog(ReinspectionHinovaService.name, 'Envio de fotos de revistoria à Hinova', opcoes.debugId, meta)}`;
    if (statusTentativa === ReinspectionHinovaEnvioStatus.ENVIADA) {
      this.logger.log(linha);
    } else {
      this.logger.error(linha);
    }

    return {
      envioId: envio.id,
      reinspectionId: reinspection.id,
      status: statusTentativa,
      hinovaEnvioStatus,
      totalFotos: fotosResultado.length,
      totalInseridas,
      totalFalhas,
      httpStatus,
      errorMessage,
      fotos: fotosResultado,
    };
  }

  /** Revistorias aprovadas/finalizadas com fotos ainda não inseridas na Hinova. */
  async listarPendentes() {
    const reinspections = await this.prisma.reinspection.findMany({
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

    return reinspections.map(({ userVehicle, photos, _count, ...r }) => ({
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
    const reinspection = await this.prisma.reinspection.findUnique({
      where: { id: reinspectionId },
      select: {
        id: true,
        hinovaEnvioStatus: true,
        hinovaUltimoEnvioEm: true,
      },
    });

    if (!reinspection) {
      throw new NotFoundException('Revistoria não encontrada');
    }

    const envios = await this.prisma.reinspectionHinovaEnvio.findMany({
      where: { reinspectionId },
      orderBy: { createdAt: 'desc' },
    });

    return { ...reinspection, envios };
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private selecionarFotos(
    fotos: FotoSelecionada[],
    opcoes: EnviarFotosOpcoes,
  ): FotoSelecionada[] {
    if (opcoes.photoIds && opcoes.photoIds.length > 0) {
      const ids = new Set(opcoes.photoIds);
      const selecionadas = fotos.filter((f) => ids.has(f.id));
      if (selecionadas.length !== ids.size) {
        throw new BadRequestException(
          'Uma ou mais fotos informadas não pertencem a esta revistoria',
        );
      }
      return opcoes.forcar
        ? selecionadas
        : selecionadas.filter((f) => !f.sentToHinova);
    }

    return opcoes.forcar ? fotos : fotos.filter((f) => !f.sentToHinova);
  }

  /**
   * Casa o retorno da Hinova (`[{ nome_arquivo, situacao }]`) com as fotos
   * enviadas. Nomes repetidos são atribuídos na ordem de envio.
   */
  private aplicarRetorno(
    enviadas: FotoLida[],
    retorno: RetornoHinovaFoto[],
    resultados: Map<number, ResultadoEnvioFoto>,
  ) {
    const filaPorNome = new Map<string, number[]>();
    for (const foto of enviadas) {
      const fila = filaPorNome.get(foto.nomeArquivo) ?? [];
      fila.push(foto.id);
      filaPorNome.set(foto.nomeArquivo, fila);
    }

    for (const item of retorno) {
      const nome = item?.nome_arquivo;
      if (!nome) continue;
      const photoId = filaPorNome.get(nome)?.shift();
      if (photoId == null) continue;

      const situacao = item.situacao != null ? String(item.situacao) : null;
      const resultado = resultados.get(photoId)!;
      resultado.situacao = situacao;
      resultado.inserida = situacao === SITUACAO_INSERIDO;
      resultado.erro = resultado.inserida
        ? null
        : `Hinova não inseriu a foto (situacao: ${situacao ?? 'vazia'})`;
    }

    for (const foto of enviadas) {
      const resultado = resultados.get(foto.id)!;
      if (!resultado.inserida && resultado.situacao == null) {
        resultado.erro = 'Hinova não retornou resultado para esta foto';
      }
    }
  }

  private async consolidarRevistoria(
    reinspectionId: number,
    agora: Date,
  ): Promise<ReinspectionHinovaEnvioStatus> {
    const [total, enviadas] = await this.prisma.$transaction([
      this.prisma.reinspectionPhoto.count({ where: { reinspectionId } }),
      this.prisma.reinspectionPhoto.count({
        where: { reinspectionId, sentToHinova: true },
      }),
    ]);

    const status =
      total > 0 && enviadas === total
        ? ReinspectionHinovaEnvioStatus.ENVIADA
        : enviadas > 0
          ? ReinspectionHinovaEnvioStatus.PARCIAL
          : ReinspectionHinovaEnvioStatus.FALHA;

    await this.prisma.reinspection.update({
      where: { id: reinspectionId },
      data: { hinovaEnvioStatus: status, hinovaUltimoEnvioEm: agora },
    });

    return status;
  }

  private statusDaTentativa(
    total: number,
    inseridas: number,
  ): ReinspectionHinovaEnvioStatus {
    if (total > 0 && inseridas === total) {
      return ReinspectionHinovaEnvioStatus.ENVIADA;
    }
    return inseridas > 0
      ? ReinspectionHinovaEnvioStatus.PARCIAL
      : ReinspectionHinovaEnvioStatus.FALHA;
  }

  private async lerBase64(photoUrl: string | null): Promise<string> {
    if (!photoUrl) {
      throw new Error('Foto sem URL local');
    }
    try {
      const buffer = await fs.readFile(join(process.cwd(), photoUrl));
      return buffer.toString('base64');
    } catch (error) {
      throw new Error(
        `Falha ao ler arquivo local ${photoUrl}: ${this.mensagem(error)}`,
      );
    }
  }

  /** Resposta da Hinova sem binários, limitada para caber no log. */
  private resumirResposta(data: unknown): Prisma.InputJsonValue {
    if (Array.isArray(data)) {
      return data.slice(0, 200).map((item: RetornoHinovaFoto) => ({
        nome_arquivo: item?.nome_arquivo ?? null,
        situacao: item?.situacao ?? null,
      }));
    }
    return {
      raw: this.truncar(this.textoResposta(data), RESPONSE_BODY_MAX_CHARS),
    };
  }

  private textoResposta(data: unknown): string {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data);
    } catch {
      return Object.prototype.toString.call(data);
    }
  }

  private mensagem(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private truncar(
    valor: string | null | undefined,
    max: number,
  ): string | null {
    if (valor == null) return null;
    return valor.length > max ? valor.slice(0, max) : valor;
  }
}

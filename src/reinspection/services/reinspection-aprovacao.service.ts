import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ReinspectionBoletoStatus,
  ReinspectionHinovaEnvioOrigem,
  ReinspectionStatus,
} from '@prisma/client';
import { ORIGENS } from 'src/reinspection/domain/revistoria-transicoes';
import { ReinspectionPhotoRepository } from 'src/reinspection/repositories/reinspection-photo.repository';
import {
  EstadoDaRevistoria,
  ReinspectionRepository,
} from 'src/reinspection/repositories/reinspection.repository';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import { debugLog } from 'src/shared/debug-log.util';

/** Usuário do painel que disparou a ação (para auditoria do envio à Hinova). */
export interface ReinspectionActor {
  userId?: number;
  email?: string;
}

export interface BoletoDaAprovacao {
  status: string;
  nossoNumero: string | null;
  tentativas: number;
  proximaTentativaEm: Date | null;
  erro: string | null;
}

export interface EnvioHinovaDaAprovacao {
  envioId: number | null;
  status: string;
  totalFotos: number;
  totalInseridas: number;
  totalFalhas: number;
}

/** Efeito da aprovação que não se completou (campo aditivo da resposta). */
export interface FalhaDeEfeito {
  etapa: 'HINOVA' | 'BOLETO';
  erro: string;
}

interface EfeitosDaAprovacao {
  boleto: BoletoDaAprovacao | null;
  hinovaEnvio: EnvioHinovaDaAprovacao | null;
  falhas: FalhaDeEfeito[];
}

const mensagem = (erro: unknown) =>
  erro instanceof Error ? erro.message : String(erro);

/** Aprovação da revistoria pelo painel e os efeitos dela (Hinova e boleto). */
@Injectable()
export class ReinspectionAprovacaoService {
  private readonly logger = new Logger(ReinspectionAprovacaoService.name);

  constructor(
    private readonly revistorias: ReinspectionRepository,
    private readonly fotos: ReinspectionPhotoRepository,
    private readonly hinova: ReinspectionHinovaService,
    private readonly boleto: BoletoReativacaoService,
  ) {}

  /**
   * Aprova a última revistoria do veículo.
   *
   * O envio das fotos à Hinova e o boleto de reativação (que dispara o
   * e-mail) só rodam para o pedido que GANHOU a transição para APROVADA.
   * Aprovação repetida ou simultânea responde 200 com o estado atual e
   * `repetida = true`, sem refazer nada.
   *
   * Uma exceção, de propósito: revistoria que JÁ estava APROVADA quando o
   * pedido chegou e cujo boleto nunca teve tentativa registrada
   * (`NAO_GERADO`). É o que sobra quando o processo cai entre a aprovação e
   * o boleto; nem o retry nem o "gerar agora" atuam em `NAO_GERADO`, e
   * aprovar de novo sempre foi o caminho de recuperação. Os efeitos são
   * retomados — o lease do boleto e o do envio à Hinova garantem que um
   * clique duplo não gere nada em dobro.
   */
  async aprovar(
    userVehicleId: number,
    debugId?: string,
    ator?: ReinspectionActor,
  ) {
    const veiculo = await this.revistorias.veiculo(userVehicleId);
    if (!veiculo) {
      throw new NotFoundException('Veículo não encontrado');
    }

    const ultima = await this.revistorias.ultimaDoVeiculo(userVehicleId);
    if (!ultima) {
      throw new NotFoundException(
        'Nenhuma revistoria encontrada para este veículo',
      );
    }

    if (await this.fotos.existeReprovada(ultima.id)) {
      throw new BadRequestException(
        'Não é possível aprovar uma revistoria com foto reprovada',
      );
    }

    const { ganhou, status } = await this.revistorias.transicionar(
      ultima.id,
      ORIGENS.APROVAR,
      ReinspectionStatus.APROVADA,
      { repeticaoIdempotente: true },
    );
    const aprovada = await this.revistorias.estadoOuFalha(ultima.id);

    const retomar =
      !ganhou &&
      ultima.status === ReinspectionStatus.APROVADA &&
      aprovada.boletoStatus === ReinspectionBoletoStatus.NAO_GERADO;
    if (retomar) {
      this.logger.warn(
        `Revistoria ${aprovada.id} já aprovada e sem tentativa de boleto: retomando os efeitos da aprovação`,
      );
    }

    const efeitos: EfeitosDaAprovacao =
      ganhou || retomar
        ? await this.efeitosDaAprovacao(aprovada, debugId, ator)
        : { boleto: boletoAtual(aprovada), hinovaEnvio: null, falhas: [] };

    return {
      reinspectionId: aprovada.id,
      userVehicleId: aprovada.userVehicleId,
      status,
      createdAt: aprovada.createdAt,
      updatedAt: aprovada.updatedAt,
      // Campo aditivo: o painel atual ignora.
      boleto: efeitos.boleto,
      // Campos aditivos da fase 4.
      repetida: !ganhou,
      hinovaEnvio: efeitos.hinovaEnvio,
      falhas: efeitos.falhas,
    };
  }

  /**
   * "Gerar boleto agora" do painel: mesma lógica do retry (adota boleto já
   * existente no SGA ou cadastra). Só para revistoria APROVADA.
   */
  async gerarBoleto(reinspectionId: number, debugId?: string) {
    const revistoria = await this.revistorias.estadoOuFalha(reinspectionId);
    if (revistoria.status !== ReinspectionStatus.APROVADA) {
      throw new BadRequestException(
        'Somente revistorias APROVADA podem gerar boleto de reativação',
      );
    }
    return this.boleto.processar(reinspectionId, { origem: 'MANUAL', debugId });
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * Efeitos de quem ganhou a aprovação. Falha em um deles não desfaz a
   * aprovação nem derruba a resposta (contrato da rota); fica registrada em
   * `falhas`, e o painel tem os caminhos manuais
   * (`POST /:id/hinova/reenviar` e `POST /:id/boleto/gerar`).
   */
  private async efeitosDaAprovacao(
    revistoria: EstadoDaRevistoria,
    debugId?: string,
    ator?: ReinspectionActor,
  ): Promise<EfeitosDaAprovacao> {
    const falhas: FalhaDeEfeito[] = [];
    const meta = {
      reinspectionId: revistoria.id,
      userVehicleId: revistoria.userVehicleId,
    };
    const registrar = (
      etapa: FalhaDeEfeito['etapa'],
      texto: string,
      erro: unknown,
    ) => {
      falhas.push({ etapa, erro: mensagem(erro) });
      this.logger.error(
        debugLog(ReinspectionAprovacaoService.name, texto, debugId, {
          ...meta,
          error: mensagem(erro),
        }),
      );
    };

    // 1) Fotos à Hinova: cada tentativa fica em ReinspectionHinovaEnvio.
    let hinovaEnvio: EnvioHinovaDaAprovacao | null = null;
    try {
      const envio = await this.hinova.enviarFotos(revistoria.id, {
        origem: ReinspectionHinovaEnvioOrigem.APROVACAO,
        adminPanelUserId: ator?.userId,
        adminPanelUserEmail: ator?.email,
        debugId,
      });
      if (envio) {
        hinovaEnvio = {
          envioId: envio.envioId,
          status: envio.status,
          totalFotos: envio.totalFotos,
          totalInseridas: envio.totalInseridas,
          totalFalhas: envio.totalFalhas,
        };
        if (envio.totalFalhas > 0) {
          this.logger.warn(
            debugLog(
              ReinspectionAprovacaoService.name,
              'Envio à Hinova na aprovação com falhas',
              debugId,
              { ...meta, ...hinovaEnvio },
            ),
          );
        }
      }
    } catch (erro) {
      registrar(
        'HINOVA',
        'Falha ao enviar revistoria aprovada para Hinova',
        erro,
      );
    }

    // 2) Boleto de reativação + e-mail de aprovação (o e-mail só sai quando
    //    o boleto existe; em instabilidade do SGA entra o retry e, em falha
    //    definitiva, a cobrança recebe e-mail para gerar à mão).
    let boleto: BoletoDaAprovacao | null = null;
    try {
      const resultado = await this.boleto.processar(revistoria.id, {
        origem: 'APROVACAO',
        debugId,
      });
      boleto = {
        status: resultado.status,
        nossoNumero: resultado.nossoNumero,
        tentativas: resultado.tentativas,
        proximaTentativaEm: resultado.proximaTentativaEm,
        erro: resultado.erro,
      };
    } catch (erro) {
      registrar('BOLETO', 'Falha inesperada no boleto de reativação', erro);
    }

    return { boleto, hinovaEnvio, falhas };
  }
}

/** Boleto como está gravado (resposta da aprovação repetida). */
function boletoAtual(revistoria: EstadoDaRevistoria): BoletoDaAprovacao {
  return {
    status: revistoria.boletoStatus,
    nossoNumero: revistoria.boletoNossoNumero,
    tentativas: revistoria.boletoTentativas,
    proximaTentativaEm: revistoria.boletoProximaTentativaEm,
    erro: revistoria.boletoUltimoErro,
  };
}

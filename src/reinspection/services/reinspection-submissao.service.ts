import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ReinspectionStatus } from '@prisma/client';
import {
  UsuarioAutenticado,
  exigirDonoOuAdmin,
} from 'src/infra/auth/usuario-autenticado';
import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import { MailService } from 'src/infra/mail/mail.service';
import { ReinspectionRepository } from 'src/reinspection/repositories/reinspection.repository';
import { debugLog } from 'src/shared/debug-log.util';

/** Resultado do aviso por e-mail aos analistas (campo aditivo da resposta). */
export type NotificacaoDaSubmissao =
  /** Este pedido enviou o e-mail. */
  | 'ENVIADA'
  /** Pedido repetido: o e-mail desta revistoria já tinha saído. */
  | 'JA_ENVIADA'
  /** Pedido simultâneo: outro está enviando agora. */
  | 'EM_ANDAMENTO'
  /** O envio falhou; uma nova submissão tenta de novo. */
  | 'FALHOU';

/** Por quanto tempo a submissão de uma revistoria fica marcada como feita. */
const VALIDADE_DA_SUBMISSAO_HORAS = 24 * 30;

/** O e-mail aos analistas falhou (libera a marca de submissão). */
class FalhaNoAvisoAosAnalistas extends Error {}

/** Submissão da revistoria para análise (fecha o envio das fotos). */
@Injectable()
export class ReinspectionSubmissaoService {
  private readonly logger = new Logger(ReinspectionSubmissaoService.name);

  constructor(
    private readonly revistorias: ReinspectionRepository,
    private readonly mail: MailService,
    private readonly idempotencia: IdempotenciaService,
  ) {}

  /**
   * Fecha o envio: avisa os analistas por e-mail. Exige PENDENTE e ao menos
   * uma foto. NÃO muda o status — o app chama `PATCH /status` em seguida.
   *
   * O aviso sai uma vez por revistoria: submissão repetida ou simultânea
   * responde 200 com o estado atual, sem outro e-mail.
   */
  async submeter(
    reinspectionId: number,
    usuario: UsuarioAutenticado,
    debugId?: string,
  ) {
    const revistoria = await this.revistorias.comDonoEFotos(reinspectionId);
    if (!revistoria) {
      throw new NotFoundException('Revistoria não encontrada');
    }
    exigirDonoOuAdmin(usuario, revistoria.userVehicle.userId);

    if (revistoria.status !== ReinspectionStatus.PENDENTE) {
      throw new BadRequestException(
        'Somente revistorias com status PENDENTE podem ser submetidas',
      );
    }
    if (revistoria.photos.length === 0) {
      throw new BadRequestException(
        'É necessário enviar pelo menos uma foto antes de submeter a revistoria',
      );
    }

    const notificacao = await this.avisarAnalistasUmaVez(revistoria, debugId);

    return {
      reinspectionId: revistoria.id,
      status: revistoria.status,
      totalPhotos: revistoria.photos.length,
      // Campo aditivo.
      notificacao,
    };
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * E-mail "nova vistoria recebida", no máximo uma vez por revistoria.
   *
   * A marca de "já submetida" é uma chave de idempotência do dono do
   * veículo (`ChaveDeIdempotencia`, índice único): a primeira submissão
   * reserva e envia; as seguintes não enviam. Se o e-mail falha, a chave é
   * liberada e a próxima submissão tenta de novo.
   */
  private async avisarAnalistasUmaVez(
    revistoria: {
      id: number;
      photos: Array<{ url: string | null }>;
      userVehicle: { userId: number; chassi: string; plate: string | null };
    },
    debugId?: string,
  ): Promise<NotificacaoDaSubmissao> {
    let enviouAgora = false;
    try {
      await this.idempotencia.executar(
        {
          userId: revistoria.userVehicle.userId,
          escopo: 'revistoria.submit',
          chave: `revistoria-${revistoria.id}`,
          corpo: { reinspectionId: revistoria.id },
          validadeHoras: VALIDADE_DA_SUBMISSAO_HORAS,
        },
        async () => {
          try {
            await this.mail.sendRevistoriaEmail(
              revistoria.userVehicle.chassi,
              revistoria.userVehicle.plate,
              debugId,
              revistoria.photos
                .map((foto) => foto.url)
                .filter((url): url is string => url !== null),
            );
          } catch (erro) {
            throw new FalhaNoAvisoAosAnalistas(
              erro instanceof Error ? erro.message : String(erro),
            );
          }
          enviouAgora = true;
          return { reinspectionId: revistoria.id };
        },
      );
      return enviouAgora ? 'ENVIADA' : 'JA_ENVIADA';
    } catch (erro) {
      if (erro instanceof FalhaNoAvisoAosAnalistas) {
        // A resposta continua 200 (contrato do app) e diz que o aviso falhou.
        this.logger.error(
          debugLog(
            ReinspectionSubmissaoService.name,
            'Falha ao enviar e-mail de revistoria',
            debugId,
            { reinspectionId: revistoria.id, error: erro.message },
          ),
        );
        return 'FALHOU';
      }
      if (ehOperacaoEmAndamento(erro)) return 'EM_ANDAMENTO';
      throw erro;
    }
  }
}

/** 409 do `IdempotenciaService` para a chave que outra requisição segura. */
function ehOperacaoEmAndamento(erro: unknown): boolean {
  if (!(erro instanceof HttpException) || erro.getStatus() !== 409) {
    return false;
  }
  const corpo = erro.getResponse() as { code?: unknown } | string;
  return typeof corpo === 'object' && corpo.code === 'OPERACAO_EM_ANDAMENTO';
}

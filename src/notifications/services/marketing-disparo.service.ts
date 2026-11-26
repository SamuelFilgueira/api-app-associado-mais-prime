import { Injectable } from '@nestjs/common';
import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import { TravaService } from 'src/infra/redis/trava.service';
import {
  ConteudoDoDisparo,
  EstadoDoDisparo,
  chaveDeConteudo,
} from 'src/notifications/domain/push-disparo';
import { SendMarketingNotificationDto } from 'src/notifications/dto/send-marketing-notification.dto';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import {
  DisparoCriado,
  PushDisparoService,
} from 'src/notifications/services/push-disparo.service';
import { DomainError } from 'src/shared/erros/erros';

/** Trava do pedido enquanto o disparo é criado (renovada durante a criação). */
export const TRAVA_DE_CRIACAO_MS = 60_000;

export interface ContextoDoPedido {
  adminUserId?: number;
  /** Header `Idempotency-Key`, quando o cliente manda. */
  chaveDeIdempotencia?: string;
}

/**
 * Resposta do disparo imediato. `sentCount`/`skippedCount` são os campos de
 * sempre; como o envio agora acontece depois da resposta, trazem o que se
 * sabe na hora: destinatários selecionados e usuários ignorados na seleção.
 * As contagens finais ficam no histórico de disparos.
 */
export interface RespostaDoDisparo {
  sentCount: number;
  skippedCount: number;
  disparoId: number;
  estado: EstadoDoDisparo;
  totalDestinatarios: number;
  repetido?: true;
}

export function respostaDoDisparo(criado: DisparoCriado): RespostaDoDisparo {
  return {
    sentCount: criado.totalDestinatarios,
    skippedCount: criado.ignorados,
    disparoId: criado.disparoId,
    estado: criado.estado,
    totalDestinatarios: criado.totalDestinatarios,
    ...(criado.repetido ? { repetido: true as const } : {}),
  };
}

/** O mesmo pedido chegou duas vezes ao mesmo tempo. */
export function disparoEmAndamento(): DomainError {
  return new DomainError(
    'DISPARO_EM_ANDAMENTO',
    'Este disparo já está sendo processado. Aguarde alguns instantes e confira o histórico.',
    { status: 409 },
  );
}

/**
 * Disparo de marketing pedido pelo painel: imediato ou agendado.
 *
 * O imediato não envia mais dentro da requisição: registra quem pediu, cria
 * o disparo com uma entrega por destinatário, enfileira os lotes e responde.
 *
 * Uma execução por vez: o pedido corre sob trava pelo conteúdo, e um disparo
 * igual que esteja em andamento (ou recém-concluído) é devolvido no lugar de
 * um novo — dois cliques não geram duas campanhas. Com `Idempotency-Key`, a
 * repetição recebe exatamente a primeira resposta.
 */
@Injectable()
export class MarketingDisparoService {
  constructor(
    private readonly audit: MarketingNotificationAuditService,
    private readonly disparos: PushDisparoService,
    private readonly agendamento: MarketingAgendamentoService,
    private readonly trava: TravaService,
    private readonly idempotencia: IdempotenciaService,
  ) {}

  /** `POST /notifications/admin/marketing`: com `agendarPara`, só agenda. */
  disparar(dto: SendMarketingNotificationDto, contexto: ContextoDoPedido) {
    const pedido = () =>
      dto.agendarPara
        ? this.agendamento.agendar(dto, contexto.adminUserId)
        : this.dispararAgora(dto, contexto.adminUserId);

    if (!contexto.adminUserId) return pedido();
    return this.idempotencia.executar<unknown>(
      {
        userId: contexto.adminUserId,
        escopo: 'painel.marketing.disparar',
        chave: contexto.chaveDeIdempotencia,
        corpo: {
          title: dto.title,
          body: dto.body,
          data: dto.data ?? null,
          agendarPara: dto.agendarPara ?? null,
        },
      },
      pedido,
    );
  }

  async dispararAgora(
    payload: Pick<SendMarketingNotificationDto, 'title' | 'body' | 'data'>,
    adminUserId?: number,
  ): Promise<RespostaDoDisparo> {
    const conteudo: ConteudoDoDisparo = {
      tipo: 'MARKETING',
      titulo: payload.title,
      corpo: payload.body,
      dados: payload.data ?? { type: 'marketing' },
    };
    const fonte = this.disparos.fonteDeMarketing();

    const criacao = await this.trava.tentar(
      `push-disparo:${chaveDeConteudo(conteudo)}`,
      TRAVA_DE_CRIACAO_MS,
      async () => {
        const repetido = await this.disparos.buscarRepetido(
          conteudo,
          new Date(),
        );
        if (repetido) return this.disparos.retomar(repetido, fonte);

        const auditId = await this.audit.createRequestAudit(
          adminUserId,
          payload as SendMarketingNotificationDto,
        );
        return this.disparos.criar(
          { ...conteudo, marketingAuditLogId: auditId },
          fonte,
        );
      },
    );
    if (!criacao.executou) throw disparoEmAndamento();

    return respostaDoDisparo(criacao.valor);
  }
}

import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import { TravaService } from 'src/infra/redis/trava.service';
import {
  chaveDeConteudo,
  serializarEstavel,
} from 'src/notifications/domain/push-disparo';
import { SendMarketingNotificationDto } from 'src/notifications/dto/send-marketing-notification.dto';
import { PushDisparoRepository } from 'src/notifications/repositories/push-disparo.repository';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { PushDisparoService } from 'src/notifications/services/push-disparo.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { MARKETING_AGENDADA_QUEUE } from 'src/queue/queue.module';
import { DomainError } from 'src/shared/erros/erros';

export const JOB_MARKETING_AGENDADA = 'enviar-marketing-agendada';

export interface MarketingAgendadaJobData {
  auditId: number;
}

/** Antecedência mínima e máxima de um agendamento. */
const ANTECEDENCIA_MINIMA_MS = 60_000;
const ANTECEDENCIA_MAXIMA_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * Agendamento já vencido há mais que isto NÃO é enviado (ex.: servidor
 * parado por horas): campanha fora de hora é pior que falha.
 */
const TOLERANCIA_ATRASO_MS = 6 * 60 * 60 * 1000;
/** Trava do pedido de agendamento (só enquanto ele é gravado). */
const TRAVA_DO_AGENDAMENTO_MS = 30_000;

const jobIdDoAgendamento = (auditId: number) => `marketing-agendada-${auditId}`;

/**
 * Disparo de push de marketing agendado.
 *
 * A fonte da verdade é o `MarketingNotificationAuditLog` (status `SCHEDULED`
 * + `scheduledFor`); o job atrasado no Redis é só o despertador, recriado
 * pela varredura periódica (`reconciliarPendentes`). Na hora marcada o job
 * NÃO envia: cria o disparo (`PushDisparo`), grava as entregas e enfileira
 * os lotes — o mesmo caminho do disparo imediato. Os destinatários são
 * calculados nesse momento, não na hora do agendamento.
 *
 * Status: SCHEDULED → SENDING → SENT | FAILED; SCHEDULED → CANCELED.
 */
@Injectable()
export class MarketingAgendamentoService {
  private readonly logger = new Logger(MarketingAgendamentoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: MarketingNotificationAuditService,
    private readonly repo: PushDisparoRepository,
    private readonly disparos: PushDisparoService,
    private readonly produtor: ProdutorDeFilas,
    private readonly trava: TravaService,
    @InjectQueue(MARKETING_AGENDADA_QUEUE) private readonly fila: Queue,
  ) {}

  /** Agenda o disparo. Resposta compatível com a do envio imediato. */
  async agendar(dto: SendMarketingNotificationDto, adminUserId?: number) {
    const agendarPara = new Date(dto.agendarPara as string);
    const antecedencia = agendarPara.getTime() - Date.now();

    if (Number.isNaN(agendarPara.getTime())) {
      throw new BadRequestException('Data de agendamento inválida');
    }
    if (antecedencia < ANTECEDENCIA_MINIMA_MS) {
      throw new BadRequestException(
        'A data de agendamento deve ser pelo menos 1 minuto no futuro',
      );
    }
    if (antecedencia > ANTECEDENCIA_MAXIMA_MS) {
      throw new BadRequestException(
        'A data de agendamento não pode passar de 1 ano',
      );
    }

    // Dois cliques em "Agendar" com o mesmo texto e a mesma hora são o mesmo
    // agendamento: o segundo recebe o registro do primeiro.
    const chave = chaveDeConteudo({
      tipo: 'MARKETING',
      titulo: dto.title,
      corpo: dto.body,
      dados: { carga: dto.data ?? null, quando: agendarPara.toISOString() },
    });
    const execucao = await this.trava.tentar(
      `marketing-agendar:${chave}`,
      TRAVA_DO_AGENDAMENTO_MS,
      async () => {
        const existente = await this.agendamentoIdentico(dto, agendarPara);
        const auditId =
          existente ??
          (await this.audit.createRequestAudit(adminUserId, dto, {
            agendarPara,
          }));
        if (!auditId) {
          // Sem o registro não há o que o job enviar nem quem responsabilizar.
          throw new BadRequestException(
            'Não foi possível registrar o agendamento para o usuário logado',
          );
        }
        await this.garantirJob(auditId, agendarPara);
        return { auditId, repetido: existente !== null };
      },
    );
    if (!execucao.executou) {
      throw new DomainError(
        'DISPARO_EM_ANDAMENTO',
        'Este agendamento já está sendo registrado. Confira o histórico de disparos.',
        { status: 409 },
      );
    }

    return {
      agendado: true,
      id: execucao.valor.auditId,
      agendarPara: agendarPara.toISOString(),
      // Mesmos campos do envio imediato, para clientes que só leem estes.
      sentCount: 0,
      skippedCount: 0,
      ...(execucao.valor.repetido ? { repetido: true } : {}),
    };
  }

  /** Cancela um agendamento ainda não enviado e registra quem cancelou. */
  async cancelar(auditId: number, adminUserId?: number) {
    const existe = await this.prisma.marketingNotificationAuditLog.findUnique({
      where: { id: auditId },
      select: { id: true, status: true },
    });
    if (!existe) throw new NotFoundException('Disparo não encontrado');

    // Transição atômica: se o job já começou a enviar, não cancela.
    const { count } =
      await this.prisma.marketingNotificationAuditLog.updateMany({
        where: { id: auditId, status: 'SCHEDULED' },
        data: {
          status: 'CANCELED',
          canceledAt: new Date(),
          canceledByAdminPanelUserId: adminUserId ?? null,
          processedAt: new Date(),
        },
      });
    if (count === 0) {
      throw new ConflictException(
        'Este disparo não está mais agendado (já enviado, em envio ou cancelado)',
      );
    }

    // O cancelamento já vale pelo status: se o despertador ficar no Redis,
    // o job encontra o disparo fora de `SCHEDULED` e não faz nada.
    await this.fila.remove(jobIdDoAgendamento(auditId)).catch(() => undefined);

    this.logger.log(
      `[MARKETING][AGENDADO] disparo #${auditId} cancelado por admin #${adminUserId ?? 'N/A'}`,
    );
    return { cancelado: true, id: auditId };
  }

  /**
   * Executado pelo job na hora marcada. Reivindica o agendamento e cria o
   * disparo na mesma transação; depois grava as entregas e enfileira os
   * lotes. Qualquer falha LANÇA (o job repete): a nova tentativa encontra o
   * disparo já criado e continua de onde parou.
   */
  async executar(auditId: number): Promise<void> {
    const disparo =
      (await this.repo.reivindicarAgendado(auditId)) ??
      (await this.repo.disparoDoLog(auditId));

    if (!disparo) {
      this.logger.warn(
        `[MARKETING][AGENDADO] disparo #${auditId} ignorado: não está mais agendado`,
      );
      return;
    }

    const criado = await this.disparos.retomar(
      disparo,
      this.disparos.fonteDeMarketing(),
    );
    this.logger.log(
      `[MARKETING][AGENDADO] disparo #${auditId} → push #${criado.disparoId} (${criado.estado}): ${criado.totalDestinatarios} destinatário(s)`,
    );
  }

  /**
   * Chamado pela varredura periódica: recria o despertador de todo
   * agendamento pendente (reinício, Redis limpo, job esgotado) e fecha como
   * falho o que venceu além da tolerância.
   */
  async reconciliarPendentes(
    agora: Date = new Date(),
  ): Promise<{ agendados: number; perdidos: number }> {
    const pendentes = await this.prisma.marketingNotificationAuditLog.findMany({
      where: { status: 'SCHEDULED', scheduledFor: { not: null } },
      select: { id: true, scheduledFor: true },
    });

    let agendados = 0;
    let perdidos = 0;
    for (const pendente of pendentes) {
      const quando = pendente.scheduledFor as Date;
      if (agora.getTime() - quando.getTime() > TOLERANCIA_ATRASO_MS) {
        const { count } =
          await this.prisma.marketingNotificationAuditLog.updateMany({
            where: { id: pendente.id, status: 'SCHEDULED' },
            data: {
              status: 'FAILED',
              errorMessage:
                'Horário agendado perdido (servidor indisponível); disparo não enviado.',
              processedAt: agora,
            },
          });
        perdidos += count;
        continue;
      }
      await this.garantirJob(pendente.id, quando);
      agendados++;
    }

    return { agendados, perdidos };
  }

  /** Histórico de disparos (imediatos e agendados) com quem pediu e quando. */
  async listarHistorico(limite = 50) {
    const take = Math.min(Math.max(Math.trunc(limite) || 50, 1), 200);
    const linhas = await this.prisma.marketingNotificationAuditLog.findMany({
      orderBy: { requestedAt: 'desc' },
      take,
      include: {
        adminPanelUser: { select: { id: true, name: true, email: true } },
      },
    });

    const idsCancelou = [
      ...new Set(
        linhas
          .map((l) => l.canceledByAdminPanelUserId)
          .filter((id): id is number => id != null),
      ),
    ];
    const quemCancelou = idsCancelou.length
      ? await this.prisma.adminPanelUser.findMany({
          where: { id: { in: idsCancelou } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const porId = new Map(quemCancelou.map((u) => [u.id, u]));

    return linhas.map((l) => ({
      id: l.id,
      tipo: l.tipo,
      title: l.title,
      body: l.body,
      data: l.messagePayload,
      status: l.status,
      requestedAt: l.requestedAt,
      scheduledFor: l.scheduledFor,
      processedAt: l.processedAt,
      sentCount: l.sentCount,
      skippedCount: l.skippedCount,
      errorMessage: l.errorMessage,
      solicitadoPor: l.adminPanelUser,
      canceledAt: l.canceledAt,
      canceladoPor: l.canceledByAdminPanelUserId
        ? (porId.get(l.canceledByAdminPanelUserId) ?? {
            id: l.canceledByAdminPanelUserId,
            name: null,
            email: null,
          })
        : null,
    }));
  }

  /** Agendamento ainda pendente com o mesmo texto, carga e horário. */
  private async agendamentoIdentico(
    dto: SendMarketingNotificationDto,
    agendarPara: Date,
  ): Promise<number | null> {
    const candidatos = await this.prisma.marketingNotificationAuditLog.findMany(
      {
        where: {
          status: 'SCHEDULED',
          tipo: 'MARKETING',
          title: dto.title,
          scheduledFor: agendarPara,
        },
        select: { id: true, body: true, messagePayload: true },
        orderBy: { id: 'asc' },
        take: 20,
      },
    );
    const carga = serializarEstavel(dto.data ?? { type: 'marketing' });
    const igual = candidatos.find(
      (c) =>
        c.body === dto.body && serializarEstavel(c.messagePayload) === carga,
    );
    return igual?.id ?? null;
  }

  /**
   * Garante o job atrasado do agendamento (id determinístico). Um job que
   * já rodou até o fim ou esgotou as tentativas, com o disparo ainda
   * `SCHEDULED`, não serve mais de despertador: é trocado por um novo.
   */
  private async garantirJob(auditId: number, quando: Date): Promise<void> {
    const jobId = jobIdDoAgendamento(auditId);
    const existente = await this.fila.getJob(jobId);
    if (existente) {
      const estado = await existente.getState();
      if (estado !== 'completed' && estado !== 'failed') return;
      await existente.remove();
    }

    await this.produtor.enfileirar<MarketingAgendadaJobData>(
      MARKETING_AGENDADA_QUEUE,
      JOB_MARKETING_AGENDADA,
      { auditId },
      {
        jobId,
        atrasoMs: Math.max(0, quando.getTime() - Date.now()),
        // Só um despertador: depois de tocar não precisa ficar no Redis.
        opcoes: { removeOnComplete: true },
      },
    );
  }
}

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
import { SendMarketingNotificationDto } from 'src/notifications/dto/send-marketing-notification.dto';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import { MARKETING_AGENDADA_QUEUE } from 'src/queue/queue.module';

export const JOB_MARKETING_AGENDADA = 'enviar-marketing-agendada';

export interface MarketingAgendadaJobData {
  auditId: number;
}

/** Antecedência mínima e máxima de um agendamento. */
const ANTECEDENCIA_MINIMA_MS = 60_000;
const ANTECEDENCIA_MAXIMA_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * Agendamento encontrado no boot já vencido há mais que isto NÃO é enviado
 * (ex.: servidor parado por horas): campanha fora de hora é pior que falha.
 */
const TOLERANCIA_ATRASO_MS = 6 * 60 * 60 * 1000;
/** `SENDING` há mais que isto no boot = envio interrompido por reinício. */
const ENVIO_TRAVADO_MS = 10 * 60 * 1000;

const jobIdDoAgendamento = (auditId: number) => `marketing-agendada-${auditId}`;

/**
 * Disparo de push de marketing agendado.
 *
 * A fonte da verdade é o `MarketingNotificationAuditLog` (status `SCHEDULED`
 * + `scheduledFor`); o job atrasado no Redis é só o despertador e é recriado
 * no boot por `reconciliarPendentes`. Os destinatários são calculados na hora
 * do envio (mesmo `NotificationsService.sendMarketingNotification` do disparo
 * imediato), não na hora do agendamento.
 *
 * Status: SCHEDULED → SENDING → SENT | FAILED; SCHEDULED → CANCELED.
 */
@Injectable()
export class MarketingAgendamentoService {
  private readonly logger = new Logger(MarketingAgendamentoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: MarketingNotificationAuditService,
    private readonly notificationsService: NotificationsService,
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

    const auditId = await this.audit.createRequestAudit(adminUserId, dto, {
      agendarPara,
    });
    if (!auditId) {
      // Sem o registro não há o que o job enviar nem quem responsabilizar.
      throw new BadRequestException(
        'Não foi possível registrar o agendamento para o usuário logado',
      );
    }

    await this.garantirJob(auditId, agendarPara);

    return {
      agendado: true,
      id: auditId,
      agendarPara: agendarPara.toISOString(),
      // Mesmos campos do envio imediato, para clientes que só leem estes.
      sentCount: 0,
      skippedCount: 0,
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

    await this.fila.remove(jobIdDoAgendamento(auditId)).catch(() => undefined);

    this.logger.log(
      `[MARKETING][AGENDADO] disparo #${auditId} cancelado por admin #${adminUserId ?? 'N/A'}`,
    );
    return { cancelado: true, id: auditId };
  }

  /** Executado pelo job: envia se o disparo ainda estiver agendado. */
  async executar(auditId: number): Promise<void> {
    // Reivindica o envio: cancelado/duplicado/já enviado não passa daqui.
    const { count } =
      await this.prisma.marketingNotificationAuditLog.updateMany({
        where: { id: auditId, status: 'SCHEDULED' },
        data: { status: 'SENDING' },
      });
    if (count === 0) {
      this.logger.warn(
        `[MARKETING][AGENDADO] disparo #${auditId} ignorado: não está mais agendado`,
      );
      return;
    }

    const disparo =
      await this.prisma.marketingNotificationAuditLog.findUniqueOrThrow({
        where: { id: auditId },
        select: {
          title: true,
          body: true,
          messagePayload: true,
          adminPanelUserId: true,
        },
      });

    try {
      const resultado =
        await this.notificationsService.sendMarketingNotification(
          {
            title: disparo.title,
            body: disparo.body,
            data: disparo.messagePayload as SendMarketingNotificationDto['data'],
          },
          disparo.adminPanelUserId,
        );
      await this.audit.markSuccess(
        auditId,
        resultado.sentCount,
        resultado.skippedCount,
      );
      this.logger.log(
        `[MARKETING][AGENDADO] disparo #${auditId} enviado: ${resultado.sentCount} enviados, ${resultado.skippedCount} ignorados`,
      );
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      await this.audit.markFailure(auditId, mensagem);
      this.logger.error(
        `[MARKETING][AGENDADO] disparo #${auditId} falhou: ${mensagem}`,
      );
    }
  }

  /**
   * No boot: recria o job de todo agendamento pendente (reinício/Redis limpo),
   * descarta os vencidos além da tolerância e fecha envios interrompidos.
   */
  async reconciliarPendentes(): Promise<{
    agendados: number;
    perdidos: number;
    interrompidos: number;
  }> {
    const agora = Date.now();

    const interrompidos =
      await this.prisma.marketingNotificationAuditLog.updateMany({
        where: {
          status: 'SENDING',
          updatedAt: { lt: new Date(agora - ENVIO_TRAVADO_MS) },
        },
        data: {
          status: 'FAILED',
          errorMessage:
            'Envio interrompido por reinício do servidor; não foi reenviado para evitar duplicidade.',
          processedAt: new Date(),
        },
      });

    const pendentes = await this.prisma.marketingNotificationAuditLog.findMany({
      where: { status: 'SCHEDULED', scheduledFor: { not: null } },
      select: { id: true, scheduledFor: true },
    });

    let agendados = 0;
    let perdidos = 0;
    for (const pendente of pendentes) {
      const quando = pendente.scheduledFor as Date;
      if (agora - quando.getTime() > TOLERANCIA_ATRASO_MS) {
        await this.prisma.marketingNotificationAuditLog.updateMany({
          where: { id: pendente.id, status: 'SCHEDULED' },
          data: {
            status: 'FAILED',
            errorMessage:
              'Horário agendado perdido (servidor indisponível); disparo não enviado.',
            processedAt: new Date(),
          },
        });
        perdidos++;
        continue;
      }
      await this.garantirJob(pendente.id, quando);
      agendados++;
    }

    return { agendados, perdidos, interrompidos: interrompidos.count };
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

  /** Cria o job atrasado se ainda não existir (jobId determinístico). */
  private async garantirJob(auditId: number, quando: Date): Promise<void> {
    const jobId = jobIdDoAgendamento(auditId);
    if (await this.fila.getJob(jobId)) return;

    await this.fila.add(
      JOB_MARKETING_AGENDADA,
      { auditId } satisfies MarketingAgendadaJobData,
      {
        jobId,
        delay: Math.max(0, quando.getTime() - Date.now()),
        // Tentativa única: reenviar um push em massa duplicaria a campanha.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}

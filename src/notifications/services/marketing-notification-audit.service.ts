import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { SendMarketingNotificationDto } from 'src/notifications/dto/send-marketing-notification.dto';

/** Origem do disparo registrada no log. */
export type TipoDisparo = 'MARKETING' | 'SITUACAO_CADASTRO';

@Injectable()
export class MarketingNotificationAuditService {
  private readonly logger = new Logger(MarketingNotificationAuditService.name);
  private readonly timeZone = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

  constructor(private readonly prisma: PrismaService) {}

  private getNormalizedTimestamp(date: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const map = Object.fromEntries(
      parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    ) as Record<string, string>;

    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  }

  /**
   * Registra quem pediu o disparo e quando. `opcoes.tipo` identifica a origem
   * (padrão `MARKETING`); `opcoes.agendarPara` grava o disparo como agendado
   * (`SCHEDULED`) em vez de solicitado (`REQUESTED`).
   */
  async createRequestAudit(
    adminUserId: number | undefined,
    payload: SendMarketingNotificationDto,
    opcoes?: { tipo?: TipoDisparo; agendarPara?: Date },
  ): Promise<number | null> {
    if (!adminUserId) {
      this.logger.warn(
        '[MARKETING][AUDIT] Usuário do token ausente; log persistente não foi criado',
      );
      return null;
    }

    try {
      const admin = await this.prisma.adminPanelUser.findUnique({
        where: { id: adminUserId },
        select: { id: true, email: true },
      });

      if (!admin) {
        this.logger.warn(
          `[MARKETING][AUDIT] AdminPanelUser ${adminUserId} não encontrado; log persistente não foi criado`,
        );
        return null;
      }

      const created = await this.prisma.marketingNotificationAuditLog.create({
        data: {
          adminPanelUserId: admin.id,
          title: payload.title,
          body: payload.body,
          messagePayload: (payload.data ?? { type: 'marketing' }) as any,
          normalizedAt: this.getNormalizedTimestamp(),
          normalizedTimezone: this.timeZone,
          status: opcoes?.agendarPara ? 'SCHEDULED' : 'REQUESTED',
          tipo: opcoes?.tipo ?? 'MARKETING',
          scheduledFor: opcoes?.agendarPara ?? null,
        },
        select: { id: true, normalizedAt: true },
      });

      this.logger.log(
        `[MARKETING][AUDIT] disparo #${created.id} (${opcoes?.tipo ?? 'MARKETING'}) ${
          opcoes?.agendarPara
            ? `agendado para ${opcoes.agendarPara.toISOString()}`
            : 'solicitado'
        } por admin #${admin.id} (${admin.email}) em ${created.normalizedAt} ${this.timeZone}`,
      );

      return created.id;
    } catch (error) {
      this.logger.error(
        `[MARKETING][AUDIT] Falha ao salvar log de solicitação: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  async markSuccess(
    auditId: number | null,
    sentCount: number,
    skippedCount: number,
  ): Promise<void> {
    if (!auditId) return;

    try {
      await this.prisma.marketingNotificationAuditLog.update({
        where: { id: auditId },
        data: {
          status: 'SENT',
          sentCount,
          skippedCount,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(
        `[MARKETING][AUDIT] Falha ao atualizar log de sucesso #${auditId}: ${error.message}`,
        error.stack,
      );
    }
  }

  async markFailure(
    auditId: number | null,
    errorMessage: string,
  ): Promise<void> {
    if (!auditId) return;

    try {
      await this.prisma.marketingNotificationAuditLog.update({
        where: { id: auditId },
        data: {
          status: 'FAILED',
          errorMessage: errorMessage.slice(0, 500),
          processedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(
        `[MARKETING][AUDIT] Falha ao atualizar log de erro #${auditId}: ${error.message}`,
        error.stack,
      );
    }
  }
}

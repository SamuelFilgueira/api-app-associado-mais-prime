import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

export type AcaoPopup = 'CRIADO' | 'ATUALIZADO';

interface PopupGravado {
  id: number;
  imageUrl: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  active: boolean;
}

/**
 * Log de inclusão/alteração de pop-up: qual usuário do painel fez o quê e
 * quando. Nunca interrompe o fluxo do pop-up — falha aqui só vai para o log.
 */
@Injectable()
export class PopupAuditService {
  private readonly logger = new Logger(PopupAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async registrar(
    acao: AcaoPopup,
    popup: PopupGravado,
    adminUserId?: number,
  ): Promise<void> {
    try {
      const admin = adminUserId
        ? await this.prisma.adminPanelUser.findUnique({
            where: { id: adminUserId },
            select: { id: true, name: true, email: true },
          })
        : null;

      const log = await this.prisma.notificationPopupAuditLog.create({
        data: {
          popupId: popup.id,
          acao,
          adminPanelUserId: admin?.id ?? adminUserId ?? null,
          adminName: admin?.name ?? null,
          adminEmail: admin?.email ?? null,
          imageUrl: popup.imageUrl,
          linkUrl: popup.linkUrl,
          linkLabel: popup.linkLabel,
          active: popup.active,
        },
        select: { createdAt: true },
      });

      this.logger.log(
        `[POPUP][AUDIT] pop-up #${popup.id} ${acao} (ativo=${popup.active}) por admin #${adminUserId ?? 'N/A'} (${admin?.email ?? 'desconhecido'}) em ${log.createdAt.toISOString()}`,
      );
    } catch (error) {
      this.logger.error(
        `[POPUP][AUDIT] Falha ao registrar log do pop-up #${popup.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Histórico mais recente primeiro. */
  async listar(limite = 50) {
    const take = Math.min(Math.max(Math.trunc(limite) || 50, 1), 200);
    const linhas = await this.prisma.notificationPopupAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
    });
    return linhas.map((l) => ({
      id: l.id,
      popupId: l.popupId,
      acao: l.acao,
      active: l.active,
      imageUrl: l.imageUrl,
      linkUrl: l.linkUrl,
      linkLabel: l.linkLabel,
      createdAt: l.createdAt,
      usuario: {
        id: l.adminPanelUserId,
        name: l.adminName,
        email: l.adminEmail,
      },
    }));
  }
}

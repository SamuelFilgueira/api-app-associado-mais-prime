import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import {
  classificarEventoDeVeiculo,
  jobIdDoAlerta,
  montarAlertaDeVeiculo,
} from 'src/notifications/domain/alerta-veiculo';
import type { PedidoDePushUnitario } from 'src/notifications/services/push-unitario.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { NOTIFICATION_QUEUE } from 'src/queue/queue.module';

export const JOB_ALERTA_VEICULO = 'alerta-veiculo';

export interface OpcoesDoAlerta {
  /**
   * Chave que identifica o evento de origem (ex.: id do webhook). Com ela, o
   * reprocessamento do mesmo evento não gera um segundo push.
   */
  chaveDoEvento?: string;
}

/**
 * Alerta de veículo (ignição ligada, violação de âncora) disparado pelo
 * webhook do rastreador.
 *
 * Decide QUEM recebe e enfileira um push por usuário na `NOTIFICATION_QUEUE`
 * (a fila de alerta). O envio fica com o job: falha do provedor é repetida
 * por ele, e o processamento do webhook não espera o Expo.
 */
@Injectable()
export class AlertaVeiculoService {
  private readonly logger = new Logger(AlertaVeiculoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PushGateway,
    private readonly produtor: ProdutorDeFilas,
  ) {}

  /** `sent` = pushes enfileirados; `skipped` = usuários sem token válido. */
  async dispararNotificacaoVeiculoWebhook(
    chassi: string,
    tipoevento: number | null,
    evento: string | null,
    opcoes: OpcoesDoAlerta = {},
  ): Promise<{ sent: number; skipped: number }> {
    const tipo = classificarEventoDeVeiculo(tipoevento, evento);
    if (!tipo) {
      this.logger.log(
        `[Webhook] Evento sem mapeamento de notificação: tipoevento=${tipoevento}, evento="${evento}" — ignorando`,
      );
      return { sent: 0, skipped: 0 };
    }

    // O alerta é POR VEÍCULO (`UserVehicle.notificacaoIgnicao`, gravado pelo
    // comando do app). Vínculo que ainda não tem valor próprio (`null`, de
    // antes dessa coluna) segue a preferência da conta, como sempre foi.
    const vinculos = await this.prisma.userVehicle.findMany({
      where: { chassi, isActive: true, user: { isActive: true } },
      select: {
        userId: true,
        plate: true,
        notificacaoIgnicao: true,
        user: { select: { notificacaoIgnicao: true } },
      },
    });
    const veiculos = vinculos.filter(
      (v) => v.notificacaoIgnicao ?? v.user.notificacaoIgnicao,
    );
    if (veiculos.length === 0) {
      this.logger.log(
        `[Webhook] Nenhum usuário com notificacaoIgnicao ativa para chassi "${chassi}"`,
      );
      return { sent: 0, skipped: 0 };
    }

    const usuarios = await this.prisma.user.findMany({
      where: {
        id: { in: veiculos.map((v) => v.userId) },
        isActive: true,
        expoPushToken: { not: null },
      },
      select: { id: true, expoPushToken: true, baseOrigin: true },
    });
    const porId = new Map(usuarios.map((u) => [u.id, u]));

    let sent = 0;
    let skipped = 0;
    for (const veiculo of veiculos) {
      const usuario = porId.get(veiculo.userId);
      if (!usuario || !this.gateway.tokenValido(usuario.expoPushToken)) {
        this.logger.warn(
          `[Webhook] Token inválido ou ausente para user ${veiculo.userId} — ignorando`,
        );
        skipped++;
        continue;
      }

      const alerta = montarAlertaDeVeiculo(tipo, {
        chassi,
        plate: veiculo.plate,
      });
      await this.produtor.enfileirar<PedidoDePushUnitario>(
        NOTIFICATION_QUEUE,
        JOB_ALERTA_VEICULO,
        {
          userId: usuario.id,
          expoPushToken: usuario.expoPushToken,
          ...alerta,
        },
        {
          base: usuario.baseOrigin,
          jobId: jobIdDoAlerta(opcoes.chaveDoEvento, usuario.id),
        },
      );
      sent++;
    }

    return { sent, skipped };
  }
}

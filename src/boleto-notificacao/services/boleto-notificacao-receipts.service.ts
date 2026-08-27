import { Injectable, Logger } from '@nestjs/common';
import { Expo } from 'expo-server-sdk';
import { PrismaService } from 'src/database/prisma.service';
import { baseTag } from 'src/shared/log.util';
import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';

export interface ResultadoReceipts {
  execucaoId: number;
  verificados: number;
  entregues: number;
  falhas: number;
  tokensInvalidos: number;
  pendentes: number;
}

/**
 * Verificação assíncrona dos receipts do Expo para uma execução da rotina.
 * Atualiza cada log (ENTREGUE / FALHA), invalida tokens DeviceNotRegistered e
 * recalcula a métrica de cobertura de entrega da execução.
 */
@Injectable()
export class BoletoNotificacaoReceiptsService {
  private readonly logger = new Logger(BoletoNotificacaoReceiptsService.name);
  private readonly expo = new Expo();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificacaoService: BoletoNotificacaoService,
  ) {}

  async verificarExecucao(execucaoId: number): Promise<ResultadoReceipts> {
    const execucao = await this.prisma.boletoNotificacaoExecucao.findUnique({
      where: { id: execucaoId },
      select: {
        id: true,
        tenant: true,
        tipoMensagem: true,
        totalEnfileirados: true,
      },
    });
    if (!execucao) {
      throw new Error(`Execução #${execucaoId} não encontrada`);
    }

    const tag = `[BOLETO-NOTIF][RECEIPTS]${baseTag(execucao.tenant)}[${execucao.tipoMensagem}]`;
    const resultado: ResultadoReceipts = {
      execucaoId,
      verificados: 0,
      entregues: 0,
      falhas: 0,
      tokensInvalidos: 0,
      pendentes: 0,
    };

    const pendentes = await this.prisma.boletoNotificacaoLog.findMany({
      where: {
        execucaoId,
        statusEnvio: 'ENVIADO',
        expoTicketId: { not: null },
      },
      select: {
        id: true,
        userId: true,
        expoPushToken: true,
        expoTicketId: true,
      },
    });

    if (pendentes.length === 0) {
      this.logger.log(
        `${tag} nenhum ticket pendente de receipt na execução #${execucaoId}`,
      );
    }

    const porTicket = new Map(
      pendentes.map((p) => [p.expoTicketId as string, p]),
    );
    const chunks = this.expo.chunkPushNotificationReceiptIds(
      Array.from(porTicket.keys()),
    );

    for (const chunk of chunks) {
      let receipts: Awaited<
        ReturnType<Expo['getPushNotificationReceiptsAsync']>
      >;
      try {
        receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      } catch (error) {
        this.logger.error(
          `${tag} erro ao consultar receipts: ${error.message}`,
        );
        resultado.pendentes += chunk.length;
        continue;
      }

      for (const ticketId of chunk) {
        const receipt = receipts[ticketId];
        const log = porTicket.get(ticketId);
        if (!log) continue;

        if (!receipt) {
          resultado.pendentes++; // Expo ainda não processou — nova tentativa depois
          continue;
        }

        resultado.verificados++;

        if (receipt.status === 'ok') {
          resultado.entregues++;
          await this.prisma.boletoNotificacaoLog.update({
            where: { id: log.id },
            data: { statusEnvio: 'ENTREGUE', expoErro: null },
          });
          continue;
        }

        const codigoErro = receipt.details?.error ?? 'RECEIPT_ERROR';
        const descricao =
          `${codigoErro}: ${receipt.message ?? 'erro desconhecido'}`.slice(
            0,
            255,
          );
        resultado.falhas++;
        await this.prisma.boletoNotificacaoLog.update({
          where: { id: log.id },
          data: { statusEnvio: 'FALHA', expoErro: descricao },
        });

        if (
          codigoErro === 'DeviceNotRegistered' &&
          log.userId &&
          log.expoPushToken
        ) {
          resultado.tokensInvalidos++;
          await this.notificacaoService.invalidarToken(
            log.userId,
            log.expoPushToken,
            tag,
          );
        }
      }
    }

    // Recalcula as métricas de entrega da execução a partir dos logs
    const [entregues, falhas] = await Promise.all([
      this.prisma.boletoNotificacaoLog.count({
        where: { execucaoId, statusEnvio: 'ENTREGUE' },
      }),
      this.prisma.boletoNotificacaoLog.count({
        where: { execucaoId, statusEnvio: 'FALHA' },
      }),
    ]);
    const tokensInvalidos = await this.prisma.boletoNotificacaoLog.count({
      where: { execucaoId, expoErro: { startsWith: 'DeviceNotRegistered' } },
    });

    await this.prisma.boletoNotificacaoExecucao.update({
      where: { id: execucaoId },
      data: {
        totalEntregues: entregues,
        totalFalhas: falhas,
        totalTokensInvalidos: tokensInvalidos,
        coberturaEntrega:
          execucao.totalEnfileirados > 0
            ? Math.round((entregues / execucao.totalEnfileirados) * 10000) /
              10000
            : null,
        receiptsVerificadosEm: new Date(),
      },
    });

    this.logger.log(
      `${tag} execução #${execucaoId}: verificados=${resultado.verificados} entregues=${resultado.entregues} ` +
        `falhas=${resultado.falhas} tokensInvalidos=${resultado.tokensInvalidos} pendentes=${resultado.pendentes}`,
    );

    return resultado;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import {
  PushGateway,
  ReciboPush,
  tokenMorto,
} from 'src/integrations/expo/push.gateway';
import { baseTag } from 'src/shared/log.util';
import {
  descreverRecusa,
  fatiar,
} from 'src/boleto-notificacao/domain/regua-envio';
import { cobertura } from 'src/boleto-notificacao/domain/regua-resultado';
import { ReguaDestinatarioRepository } from 'src/boleto-notificacao/repositories/regua-destinatario.repository';
import { ReguaExecucaoRepository } from 'src/boleto-notificacao/repositories/regua-execucao.repository';
import { ReguaLogRepository } from 'src/boleto-notificacao/repositories/regua-log.repository';

export interface ResultadoReceipts {
  execucaoId: number;
  verificados: number;
  entregues: number;
  falhas: number;
  tokensInvalidos: number;
  pendentes: number;
}

/** Limite de ids por consulta de recibos no Expo. */
const RECIBOS_POR_CONSULTA = 300;

/**
 * Caso de uso: verificar os recibos do Expo de uma execução da rotina.
 * Atualiza cada log (ENTREGUE / FALHA), invalida tokens DeviceNotRegistered e
 * recalcula a métrica de cobertura de entrega da execução.
 */
@Injectable()
export class BoletoNotificacaoReceiptsService {
  private readonly logger = new Logger(BoletoNotificacaoReceiptsService.name);

  constructor(
    private readonly execucoes: ReguaExecucaoRepository,
    private readonly logs: ReguaLogRepository,
    private readonly destinatarios: ReguaDestinatarioRepository,
    private readonly push: PushGateway,
  ) {}

  async verificarExecucao(execucaoId: number): Promise<ResultadoReceipts> {
    const execucao = await this.execucoes.buscarParaRecibos(execucaoId);
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

    const aguardando = await this.logs.aguardandoRecibo(execucaoId);
    if (aguardando.length === 0) {
      this.logger.log(
        `${tag} nenhum ticket pendente de receipt na execução #${execucaoId}`,
      );
    }

    // O recibo é casado com o log pelo id do ticket, nunca pela posição.
    const porTicket = new Map(
      aguardando.map((log) => [log.expoTicketId as string, log]),
    );

    for (const ticketIds of fatiar(
      Array.from(porTicket.keys()),
      RECIBOS_POR_CONSULTA,
    )) {
      let recibos: Record<string, ReciboPush>;
      try {
        recibos = await this.push.consultarRecibos(ticketIds);
      } catch (erro) {
        // Sem resposta do Expo: os tickets seguem pendentes e o resultado
        // diz isso — o job reagenda a verificação enquanto houver pendente.
        this.logger.error(
          `${tag} erro ao consultar receipts: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
        resultado.pendentes += ticketIds.length;
        continue;
      }

      for (const ticketId of ticketIds) {
        const recibo = recibos[ticketId];
        const log = porTicket.get(ticketId);
        if (!log) continue;

        if (!recibo) {
          resultado.pendentes++; // Expo ainda não processou — nova tentativa depois
          continue;
        }

        if (recibo.status === 'ok') {
          if (await this.logs.marcarEntregue(log.id)) {
            resultado.verificados++;
            resultado.entregues++;
          }
          continue;
        }

        const descricao = descreverRecusa(
          recibo.detalhe,
          recibo.mensagem,
          'RECEIPT_ERROR',
        );
        // Outra verificação pode ter tratado este ticket no mesmo instante:
        // quem não muda a linha não conta nem apaga token.
        if (!(await this.logs.marcarFalhaDeRecibo(log.id, descricao))) continue;
        resultado.verificados++;
        resultado.falhas++;

        if (tokenMorto(recibo) && log.userId && log.expoPushToken) {
          resultado.tokensInvalidos++;
          const removido = await this.destinatarios.invalidarToken(
            log.userId,
            log.expoPushToken,
          );
          this.logger.warn(
            removido
              ? `${tag} token do user ${log.userId} marcado como inválido (DeviceNotRegistered) e removido`
              : `${tag} token do user ${log.userId} recusado como inválido, mas o cadastro já está com outro token`,
          );
        }
      }
    }

    // Recalcula as métricas de entrega da execução a partir dos logs
    const totais = await this.logs.totaisDeEntrega(execucaoId);
    await this.execucoes.registrarEntrega(execucaoId, {
      totalEntregues: totais.entregues,
      totalFalhas: totais.falhas,
      totalTokensInvalidos: totais.tokensInvalidos,
      coberturaEntrega: cobertura(totais.entregues, execucao.totalEnfileirados),
    });

    this.logger.log(
      `${tag} execução #${execucaoId}: verificados=${resultado.verificados} entregues=${resultado.entregues} ` +
        `falhas=${resultado.falhas} tokensInvalidos=${resultado.tokensInvalidos} pendentes=${resultado.pendentes}`,
    );

    return resultado;
  }
}

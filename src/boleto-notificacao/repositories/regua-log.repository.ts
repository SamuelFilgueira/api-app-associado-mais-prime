import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { toUtcDateOnly } from 'src/shared/date.util';
import { CODIGO_FALHA_DE_TRANSPORTE } from 'src/boleto-notificacao/domain/regua-envio';
import {
  Destinatario,
  GrupoAssociado,
  LogExistente,
} from 'src/boleto-notificacao/domain/regua-elegibilidade';
import { TipoMensagem } from 'src/boleto-notificacao/domain/regua-tipos';

/** De qual execução/etapa é o envio que está sendo registrado. */
export interface ContextoDoLog {
  execucaoId: number;
  tenant: string;
  tipo: TipoMensagem;
}

/** Campos do log que vêm do destinatário (iguais na criação e na retomada). */
function dadosDoDestinatario(destinatario: Destinatario) {
  return {
    cpf: destinatario.cpf,
    userId: destinatario.userId,
    nossoNumero: destinatario.boletos[0]?.nossoNumero || null,
    quantidadeBoletos: destinatario.boletos.length,
    expoPushToken: destinatario.expoPushToken,
    mensagemTitulo: destinatario.titulo,
    mensagemEnviada: destinatario.corpo,
  };
}

/**
 * `BoletoNotificacaoLog`: uma linha por base × associado × vencimento ×
 * etapa (unique de idempotência). Estados:
 *
 *   (nada) → ENFILEIRADO → ENVIADO → ENTREGUE
 *                       ↘ FALHA    ↘ FALHA
 *
 * Toda transição carrega o estado de origem no `WHERE` e devolve se a linha
 * foi mesmo alterada: quem perde a corrida não registra nada por cima.
 */
@Injectable()
export class ReguaLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Logs já gravados para os grupos da etapa (pela unique de idempotência). */
  buscarExistentes(
    tenant: string,
    tipo: TipoMensagem,
    grupos: GrupoAssociado[],
  ): Promise<LogExistente[]> {
    return this.prisma.boletoNotificacaoLog.findMany({
      where: {
        tenant,
        tipoMensagem: tipo,
        dataVencimentoOriginal: {
          in: Array.from(
            new Set(grupos.map((g) => toUtcDateOnly(g.vencimento).getTime())),
          ).map((t) => new Date(t)),
        },
        codigoAssociado: {
          in: Array.from(new Set(grupos.map((g) => g.codigoAssociado))),
        },
      },
      select: {
        id: true,
        codigoAssociado: true,
        dataVencimentoOriginal: true,
        statusEnvio: true,
        expoTicketId: true,
        expoErro: true,
        atualizadoEm: true,
      },
    });
  }

  /**
   * Grava o log `ENFILEIRADO` antes do envio. Devolve `null` quando a unique
   * de idempotência barra: outra execução registrou o mesmo envio primeiro.
   */
  async criar(
    contexto: ContextoDoLog,
    destinatario: Destinatario,
  ): Promise<number | null> {
    try {
      const log = await this.prisma.boletoNotificacaoLog.create({
        data: {
          execucaoId: contexto.execucaoId,
          tenant: contexto.tenant,
          codigoAssociado: destinatario.codigoAssociado,
          dataVencimentoOriginal: toUtcDateOnly(destinatario.vencimento),
          tipoMensagem: contexto.tipo,
          statusEnvio: 'ENFILEIRADO',
          ...dadosDoDestinatario(destinatario),
        },
        select: { id: true },
      });
      return log.id;
    } catch (erro) {
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        erro.code === 'P2002'
      ) {
        return null;
      }
      throw erro;
    }
  }

  /**
   * Assume um log cujo envio não se completou em OUTRA execução (órfão
   * `ENFILEIRADO` ou falha de transporte): volta a `ENFILEIRADO`, agora desta
   * execução. Só vale se a linha continua exatamente como foi lida — se outra
   * execução mexeu nela nesse meio-tempo, devolve `false`.
   */
  async retomar(
    contexto: ContextoDoLog,
    destinatario: Destinatario,
    log: LogExistente,
  ): Promise<boolean> {
    if (!log.statusEnvio || !(log.atualizadoEm instanceof Date)) return false;
    const { count } = await this.prisma.boletoNotificacaoLog.updateMany({
      where: {
        id: log.id,
        statusEnvio: log.statusEnvio as 'ENFILEIRADO' | 'FALHA',
        expoTicketId: null,
        atualizadoEm: log.atualizadoEm,
      },
      data: {
        execucaoId: contexto.execucaoId,
        statusEnvio: 'ENFILEIRADO',
        expoErro: null,
        atualizadoEm: new Date(),
        ...dadosDoDestinatario(destinatario),
      },
    });
    return count === 1;
  }

  /**
   * Segunda rodada da MESMA execução: a falha de transporte que ela própria
   * gravou volta a `ENFILEIRADO` para um novo envio.
   */
  async retomarFalhaDeTransporte(
    id: number,
    execucaoId: number,
  ): Promise<boolean> {
    const { count } = await this.prisma.boletoNotificacaoLog.updateMany({
      where: {
        id,
        execucaoId,
        statusEnvio: 'FALHA',
        expoTicketId: null,
        expoErro: { startsWith: `${CODIGO_FALHA_DE_TRANSPORTE}:` },
      },
      data: { statusEnvio: 'ENFILEIRADO', expoErro: null },
    });
    return count === 1;
  }

  /** `ENFILEIRADO → ENVIADO`, com o ticket do Expo. */
  async marcarEnviado(
    id: number,
    execucaoId: number,
    ticketId: string | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.boletoNotificacaoLog.updateMany({
      where: { id, execucaoId, statusEnvio: 'ENFILEIRADO' },
      data: { statusEnvio: 'ENVIADO', expoTicketId: ticketId },
    });
    return count === 1;
  }

  /** `ENFILEIRADO → FALHA` (recusa do Expo ou falha de transporte). */
  async marcarFalhaDeEnvio(
    ids: number[],
    execucaoId: number,
    descricao: string,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.boletoNotificacaoLog.updateMany({
      where: { id: { in: ids }, execucaoId, statusEnvio: 'ENFILEIRADO' },
      data: { statusEnvio: 'FALHA', expoErro: descricao },
    });
    return count;
  }

  /** Pushes aceitos pelo Expo que ainda esperam recibo. */
  aguardandoRecibo(execucaoId: number) {
    return this.prisma.boletoNotificacaoLog.findMany({
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
  }

  /** `ENVIADO → ENTREGUE`. */
  async marcarEntregue(id: number): Promise<boolean> {
    const { count } = await this.prisma.boletoNotificacaoLog.updateMany({
      where: { id, statusEnvio: 'ENVIADO' },
      data: { statusEnvio: 'ENTREGUE', expoErro: null },
    });
    return count === 1;
  }

  /** `ENVIADO → FALHA`: o recibo do Expo veio com erro. */
  async marcarFalhaDeRecibo(id: number, descricao: string): Promise<boolean> {
    const { count } = await this.prisma.boletoNotificacaoLog.updateMany({
      where: { id, statusEnvio: 'ENVIADO' },
      data: { statusEnvio: 'FALHA', expoErro: descricao },
    });
    return count === 1;
  }

  /** Totais de entrega da execução, contados nos logs. */
  async totaisDeEntrega(execucaoId: number): Promise<{
    entregues: number;
    falhas: number;
    tokensInvalidos: number;
  }> {
    const [entregues, falhas, tokensInvalidos] = await Promise.all([
      this.prisma.boletoNotificacaoLog.count({
        where: { execucaoId, statusEnvio: 'ENTREGUE' },
      }),
      this.prisma.boletoNotificacaoLog.count({
        where: { execucaoId, statusEnvio: 'FALHA' },
      }),
      this.prisma.boletoNotificacaoLog.count({
        where: { execucaoId, expoErro: { startsWith: 'DeviceNotRegistered' } },
      }),
    ]);
    return { entregues, falhas, tokensInvalidos };
  }
}

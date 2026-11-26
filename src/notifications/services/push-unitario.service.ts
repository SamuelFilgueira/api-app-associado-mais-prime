import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { ExpoPushClient } from 'src/integrations/expo/expo-push.client';
import { PushGateway, tokenMorto } from 'src/integrations/expo/push.gateway';
import {
  DadosDoPush,
  mascararTokenPush,
  montarMensagemPush,
} from 'src/notifications/domain/push-mensagem';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';

export interface PedidoDePushUnitario {
  userId: number;
  expoPushToken: string;
  title: string;
  body: string;
  data: DadosDoPush;
}

export type ResultadoDoPushUnitario =
  | { status: 'enviado'; notificationId: number }
  /** Não chegou a ser enviado (token, usuário ou preferência). */
  | { status: 'ignorado'; mensagem: string }
  /**
   * O provedor respondeu que não entrega. Repetir não muda nada. A caixa de
   * entrada recebe a linha mesmo assim (`notificationId`).
   */
  | { status: 'recusado'; mensagem: string; notificationId: number }
  /**
   * Sem resposta do provedor. É o único caso que vale repetir. Só traz
   * `notificationId` na chamada direta, que não tem nova tentativa.
   */
  | { status: 'falha_transporte'; mensagem: string; notificationId?: number };

/** Formato que as rotas e os outros módulos sempre receberam. */
export interface RespostaDoPush {
  success: boolean;
  message: string;
  notificationId?: number;
}

/**
 * Memória do envio entre as tentativas de um job. Com ela, a nova tentativa
 * de um job cujo push já foi aceito só grava a caixa de entrada — não manda
 * o push de novo.
 */
export interface MemoriaDoEnvio {
  pushAceito: boolean;
  marcarPushAceito(): Promise<void>;
}

/**
 * Push para UM usuário (alerta de veículo, aviso de economia, teste).
 *
 * A caixa de entrada do app ("sino") é um canal à parte do push: o associado
 * vê o aviso ali mesmo quando o aparelho não recebeu. Por isso a linha é
 * gravada sempre que o desfecho desta chamada é DEFINITIVO:
 *
 *  - provedor aceitou ou recusou → grava;
 *  - sem resposta do provedor, dentro de um job (`memoria`) → NÃO grava: o
 *    job repete, e a linha sai na tentativa que tiver desfecho (assim a
 *    repetição não grava duas);
 *  - sem resposta do provedor, em chamada direta → grava: não haverá outra
 *    tentativa.
 */
@Injectable()
export class PushUnitarioService {
  private readonly logger = new Logger(PushUnitarioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PushGateway,
    private readonly caixa: CaixaDeEntradaService,
    private readonly tokens: PushTokenService,
  ) {}

  async enviar(
    pedido: PedidoDePushUnitario,
    memoria?: MemoriaDoEnvio,
  ): Promise<ResultadoDoPushUnitario> {
    const { userId, expoPushToken } = pedido;

    if (!this.gateway.tokenValido(expoPushToken)) {
      this.logger.warn(
        `[Push] expoPushToken inválido: ${mascararTokenPush(expoPushToken)} (user ${userId})`,
      );
      return { status: 'ignorado', mensagem: 'Token Expo inválido.' };
    }

    // O usuário precisa existir (FK da caixa de entrada).
    const usuario = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificacaoIgnicao: true },
    });
    if (!usuario) {
      return {
        status: 'ignorado',
        mensagem: `Usuario com ID ${userId} nao encontrado no banco.`,
      };
    }
    if (pedido.data?.ignition && !usuario.notificacaoIgnicao) {
      return {
        status: 'ignorado',
        mensagem: 'Preferencia de notificacao de ignicao desativada.',
      };
    }

    if (!memoria?.pushAceito) {
      const [resultado] = await this.gateway.enviar([
        montarMensagemPush(
          expoPushToken,
          pedido.title,
          pedido.body,
          pedido.data,
        ),
      ]);
      ExpoPushClient.contar('unitario', [resultado]);

      if (resultado.status === 'falha_transporte') {
        if (memoria) {
          return { status: 'falha_transporte', mensagem: resultado.mensagem };
        }
        const semEnvio = await this.caixa.gravar(pedido);
        return {
          status: 'falha_transporte',
          mensagem: resultado.mensagem,
          notificationId: semEnvio.id,
        };
      }
      if (resultado.status === 'recusado') {
        this.logger.warn(
          `[Push] recusado pelo provedor para o user ${userId}: ${resultado.detalhe ?? resultado.mensagem}`,
        );
        if (tokenMorto(resultado)) {
          await this.tokens.apagarSeAindaFor(userId, expoPushToken);
        }
        const recusada = await this.caixa.gravar(pedido);
        return {
          status: 'recusado',
          mensagem: resultado.mensagem || 'Erro no ticket Expo.',
          notificationId: recusada.id,
        };
      }
      await memoria?.marcarPushAceito();
    }

    const notificacao = await this.caixa.gravar(pedido);
    return { status: 'enviado', notificationId: notificacao.id };
  }
}

/**
 * Converte o resultado para o formato legado das rotas (`200` com
 * `success: false`). Falha de transporte também vira `success: false` aqui:
 * quem precisa repetir (o processor) decide pelo `status`, antes de converter.
 */
export function paraRespostaDoPush(
  resultado: ResultadoDoPushUnitario,
): RespostaDoPush {
  switch (resultado.status) {
    case 'enviado':
      return {
        success: true,
        message: 'Notificação enviada com sucesso.',
        notificationId: resultado.notificationId,
      };
    case 'falha_transporte':
      return {
        success: false,
        message: 'Erro ao enviar notificação.',
        notificationId: resultado.notificationId,
      };
    case 'recusado':
      return {
        success: false,
        message: resultado.mensagem,
        notificationId: resultado.notificationId,
      };
    default:
      return { success: false, message: resultado.mensagem };
  }
}

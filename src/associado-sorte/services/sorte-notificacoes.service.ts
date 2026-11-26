import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { associadoSorteConfig } from 'src/associado-sorte/config/associado-sorte.config';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { NotificationsService } from 'src/notifications/services/notifications.service';
import {
  PushAvulso,
  emLotesDePush,
} from 'src/notifications/domain/push-avulsos';
import { comEnvelope } from 'src/queue/job-envelope';
import { PUSH_MASSA_QUEUE } from 'src/queue/queue.module';
import { baseTag } from 'src/shared/log.util';

/**
 * Push do Associado da Sorte. Sempre chamado DEPOIS do commit e nunca lança:
 * falha de push não desfaz a vitória (o associado vê o prêmio ao abrir a tela).
 *
 * O app passa `data.screen` por `toLowerCase()`, então a rota é minúscula.
 *
 * Os envios em lote vão para a fila de MASSA (`PUSH_MASSA_QUEUE`), em jobs
 * de até 100 mensagens, com o retry padrão da fila.
 */
@Injectable()
export class SorteNotificacoesService {
  private readonly logger = new Logger(SorteNotificacoesService.name);

  constructor(
    private readonly ganhadoresRepository: SorteGanhadoresRepository,
    private readonly rodadasRepository: SorteRodadasRepository,
    private readonly notifications: NotificationsService,
    @InjectQueue(PUSH_MASSA_QUEUE) private readonly fila: Queue,
  ) {}

  /**
   * Avisa os ganhadores. Um só: envio imediato. Vários (apuração de
   * sorteio): enfileira na `PUSH_MASSA_QUEUE` em vez de enviar em laço.
   */
  async avisarGanhadores(ganhadorIds: number[]): Promise<void> {
    if (ganhadorIds.length === 0) return;
    try {
      const ganhadores =
        await this.ganhadoresRepository.listarParaPush(ganhadorIds);
      const mensagens = ganhadores
        .filter((g) => !!g.user.expoPushToken)
        .map((g) => ({
          userId: g.userId,
          baseOrigin: g.baseOrigin,
          expoPushToken: g.user.expoPushToken as string,
          title:
            g.origem === 'LOJA' ? 'Pedido confirmado 🎁' : 'Você ganhou! 🎉',
          body:
            g.origem === 'LOJA'
              ? `Seu pedido "${g.premio.nome}" na Loja da Sorte foi registrado. Toque para ver como retirar.`
              : `Você levou "${g.premio.nome}" no Associado da Sorte. Toque para ver como receber.`,
          data: {
            type: 'internal_route',
            screen: `associado-da-sorte/premio/${g.id}`,
          },
        }));

      const semToken = ganhadores.length - mensagens.length;
      if (semToken > 0) {
        this.logger.warn(
          `${semToken} ganhador(es) sem token de push; verão o prêmio ao abrir o app`,
        );
      }
      if (mensagens.length === 0) return;

      if (mensagens.length === 1) {
        const m = mensagens[0];
        const r = await this.notifications.sendPushNotification(
          m.userId,
          m.expoPushToken,
          m.title,
          m.body,
          m.data,
        );
        if (!r.success) {
          this.logger.warn(
            `${baseTag(m.baseOrigin)} push de ganhador não entregue ao associado #${m.userId}: ${r.message}`,
          );
        }
        return;
      }

      // Um job por base (o envelope leva a base dos ganhadores) e por grupo
      // de 100. `addBulk` não passa pelo `ProdutorDeFilas`: o envelope é
      // acrescentado aqui.
      const porBase = new Map<string, PushAvulso[]>();
      for (const { baseOrigin, ...dados } of mensagens) {
        const daBase = porBase.get(baseOrigin);
        if (daBase) daBase.push(dados);
        else porBase.set(baseOrigin, [dados]);
      }
      await this.fila.addBulk(
        [...porBase].flatMap(([baseOrigin, daBase]) =>
          emLotesDePush(daBase).map((lote) => ({
            name: 'sorte-ganhador',
            data: comEnvelope({ mensagens: lote }, baseOrigin),
          })),
        ),
      );
    } catch (erro) {
      this.logger.error(
        `Falha ao avisar ganhadores (${ganhadorIds.join(', ')}): ${(erro as Error).message}`,
      );
    }
  }

  /**
   * "Avise-me": enfileira o push de quem pediu lembrete das rodadas que
   * abrem dentro da antecedência configurada. Devolve quantos pushes entraram
   * na fila. Cada rodada é reivindicada uma única vez (`lembreteEnviadoEm`).
   */
  async enviarLembretes(agora: Date): Promise<number> {
    const { lembreteAntecedenciaMin } = associadoSorteConfig();
    const ate = new Date(agora.getTime() + lembreteAntecedenciaMin * 60_000);
    let enfileirados = 0;

    const rodadas = await this.rodadasRepository.listarParaLembrar(agora, ate);
    for (const rodada of rodadas) {
      try {
        const minha = await this.rodadasRepository.reivindicarLembrete(
          rodada.id,
          agora,
        );
        if (!minha) continue;

        const destinatarios =
          await this.rodadasRepository.listarDestinatariosDoLembrete(rodada.id);
        if (destinatarios.length === 0) continue;

        const minutos = Math.max(
          1,
          Math.round((rodada.abertura.getTime() - agora.getTime()) / 60_000),
        );
        const titulo = rodada.titulo?.trim() || rodada.premio.nome;
        const lembretes: PushAvulso[] = destinatarios.map((d) => ({
          userId: d.user.id,
          expoPushToken: d.user.expoPushToken as string,
          title: 'Está quase na hora ⏰',
          body: `"${titulo}" abre em ${minutos} min no Associado da Sorte. Prepare-se!`,
          data: {
            type: 'internal_route',
            screen: `associado-da-sorte/rodada/${rodada.id}`,
          },
        }));
        await this.fila.addBulk(
          emLotesDePush(lembretes).map((lote) => ({
            name: 'sorte-lembrete',
            // Sem base: a consulta dos destinatários não traz a base do
            // usuário; o envelope leva só os metadados de rastreio.
            data: comEnvelope({ mensagens: lote }),
          })),
        );
        enfileirados += destinatarios.length;
        this.logger.log(
          `Lembrete da rodada #${rodada.id}: ${destinatarios.length} push(es) na fila`,
        );
      } catch (erro) {
        this.logger.error(
          `Falha ao enviar lembretes da rodada #${rodada.id}: ${(erro as Error).message}`,
        );
      }
    }
    return enfileirados;
  }
}

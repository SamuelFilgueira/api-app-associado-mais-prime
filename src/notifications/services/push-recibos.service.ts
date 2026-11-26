import { Injectable, Logger } from '@nestjs/common';
import { PushGateway, tokenMorto } from 'src/integrations/expo/push.gateway';
import {
  ENTREGAS_POR_CONSULTA_DE_RECIBO,
  EntregaRecusada,
  JOB_PUSH_RECIBOS,
  RECIBOS_MAX_PASSADAS,
  RecibosJobData,
  atrasoDosRecibos,
  jobIdDosRecibos,
  resumirErro,
} from 'src/notifications/domain/push-disparo';
import { PushDisparoRepository } from 'src/notifications/repositories/push-disparo.repository';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { PUSH_MASSA_QUEUE } from 'src/queue/queue.module';

export interface ResultadoDosRecibos {
  entregues: number;
  recusadas: number;
  semRecibo: number;
}

/**
 * Recibos de entrega. O ticket só diz que o Expo ACEITOU o push; minutos
 * depois o recibo diz se o aparelho recebeu. Um job atrasado por disparo
 * consulta os recibos e marca cada entrega `ENTREGUE` ou `RECUSADA`,
 * apagando o token que o provedor deu como morto.
 */
@Injectable()
export class PushRecibosService {
  private readonly logger = new Logger(PushRecibosService.name);

  constructor(
    private readonly repo: PushDisparoRepository,
    private readonly gateway: PushGateway,
    private readonly produtor: ProdutorDeFilas,
  ) {}

  /** Agenda a consulta. Id determinístico: agendar duas vezes não duplica. */
  async agendar(disparoId: number, passada: number): Promise<void> {
    await this.produtor.enfileirar<RecibosJobData>(
      PUSH_MASSA_QUEUE,
      JOB_PUSH_RECIBOS,
      { disparoId, passada },
      {
        jobId: jobIdDosRecibos(disparoId, passada),
        atrasoMs: atrasoDosRecibos(passada),
      },
    );
  }

  /**
   * Consulta os recibos das entregas ainda `ENVIADA`. Falha do provedor
   * lança (o job repete): o que já foi marcado não volta a ser consultado.
   */
  async processar(dados: RecibosJobData): Promise<ResultadoDosRecibos> {
    const total: ResultadoDosRecibos = {
      entregues: 0,
      recusadas: 0,
      semRecibo: 0,
    };
    let aposId = 0;

    for (;;) {
      const entregas = await this.repo.entregasAguardandoRecibo(
        dados.disparoId,
        aposId,
        ENTREGAS_POR_CONSULTA_DE_RECIBO,
      );
      if (entregas.length === 0) break;

      const recibos = await this.gateway.consultarRecibos(
        entregas.map((e) => e.ticketId),
      );
      const entregues: number[] = [];
      const recusadas: EntregaRecusada[] = [];
      for (const entrega of entregas) {
        const recibo = recibos[entrega.ticketId];
        if (!recibo) {
          total.semRecibo++;
        } else if (recibo.status === 'ok') {
          entregues.push(entrega.id);
        } else {
          recusadas.push({
            id: entrega.id,
            userId: entrega.userId,
            expoPushToken: entrega.expoPushToken,
            erro: resumirErro(
              [recibo.detalhe, recibo.mensagem].filter(Boolean).join(': '),
            ),
            tokenMorto: tokenMorto(recibo),
          });
        }
      }

      const gravado = await this.repo.gravarRecibos(
        entregues,
        recusadas,
        new Date(),
      );
      total.entregues += gravado.entregues;
      total.recusadas += gravado.recusadas;

      aposId = entregas[entregas.length - 1].id;
      if (entregas.length < ENTREGAS_POR_CONSULTA_DE_RECIBO) break;
    }

    // O Expo ainda não tinha o recibo de algumas: nova passada mais tarde.
    if (total.semRecibo > 0 && dados.passada < RECIBOS_MAX_PASSADAS) {
      await this.agendar(dados.disparoId, dados.passada + 1);
    }

    this.logger.log(
      `[PUSH] recibos do disparo #${dados.disparoId} (passada ${dados.passada}): ${total.entregues} entregue(s), ${total.recusadas} recusada(s), ${total.semRecibo} sem recibo`,
    );
    return total;
  }
}

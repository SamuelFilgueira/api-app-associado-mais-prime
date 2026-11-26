import { Injectable, Logger } from '@nestjs/common';
import { TravaService } from 'src/infra/redis/trava.service';
import { ExpoPushClient } from 'src/integrations/expo/expo-push.client';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import {
  LoteJobData,
  PaginaDeEntregas,
  ResultadoDoLote,
  classificarResultados,
  contagemDoDisparo,
  desfechoDoDisparo,
} from 'src/notifications/domain/push-disparo';
import {
  DadosDoPush,
  montarMensagemPush,
} from 'src/notifications/domain/push-mensagem';
import {
  DisparoPush,
  PushDisparoRepository,
} from 'src/notifications/repositories/push-disparo.repository';
import { PushRecibosService } from 'src/notifications/services/push-recibos.service';
import {
  DomainError,
  IntegrationError,
  ehErroTransitorio,
} from 'src/shared/erros/erros';

/** Trava da página enquanto o lote roda (é renovada durante a execução). */
const TRAVA_DO_LOTE_MS = 60_000;
/** Tentativas de gravar o resultado antes de devolver o lote ao retry. */
const TENTATIVAS_DE_GRAVACAO = 3;

export interface LoteProcessado {
  enviadas: number;
  recusadas: number;
  falhas: number;
  /** Preenchido quando o lote não tinha o que fazer (disparo já fechado). */
  ignorado?: string;
}

/** Outra execução está com a mesma página. Vale repetir em instantes. */
export class LoteEmExecucaoError extends Error {}

/**
 * Envio de UM lote (uma página de entregas) do push em massa, e o
 * fechamento do disparo quando a última entrega é resolvida.
 *
 * O que torna a repetição segura:
 *  - o lote só manda as entregas ainda abertas da página (`PENDENTE`, ou
 *    `FALHA` de transporte dentro do limite de tentativas);
 *  - cada entrega muda de estado pelo próprio resultado, numa transação com
 *    a linha da caixa de entrada (ver `gravarResultadoDoLote`);
 *  - uma página só roda em uma execução por vez (trava por página).
 */
@Injectable()
export class PushLoteService {
  private readonly logger = new Logger(PushLoteService.name);

  constructor(
    private readonly repo: PushDisparoRepository,
    private readonly gateway: PushGateway,
    private readonly trava: TravaService,
    private readonly recibos: PushRecibosService,
  ) {}

  async processar(dados: LoteJobData): Promise<LoteProcessado> {
    const pagina = paginaValida(dados);
    const disparo = await this.repo.buscarDisparo(dados.disparoId);
    if (!disparo || disparo.estado !== 'ENVIANDO') {
      // Disparo já fechado (ou apagado): job repetido, nada a enviar.
      return {
        enviadas: 0,
        recusadas: 0,
        falhas: 0,
        ignorado: disparo?.estado ?? 'INEXISTENTE',
      };
    }

    const execucao = await this.trava.tentar(
      `push-lote:${disparo.id}:${pagina.deId}`,
      TRAVA_DO_LOTE_MS,
      () => this.enviarPagina(disparo, pagina),
    );
    if (!execucao.executou) {
      throw new LoteEmExecucaoError(
        `Lote ${pagina.deId}-${pagina.ateId} do disparo #${disparo.id} já está em execução`,
      );
    }

    await this.tentarFechar(disparo.id);

    if (execucao.valor.falhas > 0) {
      // As entregas ficaram em `FALHA`; o retry do job reenvia só elas.
      throw new IntegrationError({
        vendor: 'expo',
        tipo: 'indisponivel',
        detalhes: {
          disparoId: disparo.id,
          deId: pagina.deId,
          falhas: execucao.valor.falhas,
        },
      });
    }
    return execucao.valor;
  }

  /**
   * Fecha o disparo se não sobrou entrega aberta, com as contagens reais, e
   * agenda a consulta de recibos. Devolve se ESTA chamada fechou.
   */
  async tentarFechar(disparoId: number, agora = new Date()): Promise<boolean> {
    if (await this.repo.temAbertas(disparoId)) return false;

    const contagem = contagemDoDisparo(
      await this.repo.contarPorEstado(disparoId),
    );
    const desfecho = desfechoDoDisparo(contagem);
    const fechou = await this.repo.fechar(disparoId, desfecho, contagem, agora);

    // Também quando outra execução fechou: cobre a queda entre o fechamento
    // e o agendamento (o id do job é determinístico, não duplica).
    if (contagem.enviadas > 0) await this.recibos.agendar(disparoId, 1);

    if (fechou) {
      this.logger.log(
        `[PUSH] disparo #${disparoId} ${desfecho.estado}: ${contagem.enviadas} enviada(s), ${contagem.recusadas} recusada(s), ${contagem.falhas} com falha, de ${contagem.total}`,
      );
    }
    return fechou;
  }

  private async enviarPagina(
    disparo: DisparoPush,
    pagina: PaginaDeEntregas,
  ): Promise<LoteProcessado> {
    const entregas = await this.repo.entregasDaPagina(disparo.id, pagina);
    if (entregas.length === 0) return { enviadas: 0, recusadas: 0, falhas: 0 };

    const resultados = await this.gateway.enviar(
      entregas.map((entrega) =>
        montarMensagemPush(
          entrega.expoPushToken,
          disparo.titulo,
          disparo.corpo,
          (disparo.dados ?? {}) as DadosDoPush,
        ),
      ),
    );
    ExpoPushClient.contar(disparo.tipo.toLowerCase(), resultados);

    return this.gravar(disparo, classificarResultados(entregas, resultados));
  }

  /**
   * O push já saiu: perder a gravação devolveria o lote ao retry e os
   * aceitos receberiam de novo. Por isso a gravação insiste aqui mesmo antes
   * de desistir.
   */
  private async gravar(
    disparo: DisparoPush,
    resultado: ResultadoDoLote,
  ): Promise<LoteProcessado> {
    for (let tentativa = 1; ; tentativa++) {
      try {
        return await this.repo.gravarResultadoDoLote(
          disparo,
          resultado,
          new Date(),
        );
      } catch (erro) {
        if (tentativa >= TENTATIVAS_DE_GRAVACAO || !ehErroTransitorio(erro)) {
          throw erro;
        }
        await new Promise((r) => setTimeout(r, 250 * tentativa));
      }
    }
  }
}

function paginaValida(dados: LoteJobData): PaginaDeEntregas {
  const { disparoId, deId, ateId } = dados ?? ({} as LoteJobData);
  if (![disparoId, deId, ateId].every((n) => Number.isInteger(n) && n > 0)) {
    throw new DomainError(
      'PUSH_LOTE_INVALIDO',
      'Job de lote de push sem disparo ou página válidos.',
    );
  }
  return { deId, ateId };
}

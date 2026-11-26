import { Injectable, Logger } from '@nestjs/common';
import { ExpoPushClient } from 'src/integrations/expo/expo-push.client';
import { PushGateway, tokenMorto } from 'src/integrations/expo/push.gateway';
import {
  ProgressoDosAvulsos,
  PushAvulso,
  posicoesPendentes,
} from 'src/notifications/domain/push-avulsos';
import { montarMensagemPush } from 'src/notifications/domain/push-mensagem';
import { CaixaDeEntradaService } from 'src/notifications/services/caixa-de-entrada.service';
import { PushTokenService } from 'src/notifications/services/push-token.service';
import { IntegrationError } from 'src/shared/erros/erros';

/** Onde o job guarda o que já fez (os dados do próprio job no Redis). */
export interface MemoriaDosAvulsos {
  progresso?: ProgressoDosAvulsos;
  salvar(progresso: ProgressoDosAvulsos): Promise<void>;
}

export interface AvulsosEnviados {
  aceitos: number;
  recusados: number;
  invalidos: number;
}

/**
 * Envio de um job de pushes avulsos em lote (lembretes e avisos do
 * Associado da Sorte): uma chamada ao provedor para o job inteiro, e uma
 * linha na caixa de entrada por push aceito.
 *
 * Não há tabela de entregas aqui; a idempotência vem do progresso gravado no
 * próprio job: posição que já teve resposta do provedor não é reenviada na
 * nova tentativa, e a caixa de entrada pendente é gravada antes de tudo.
 */
@Injectable()
export class PushAvulsosService {
  private readonly logger = new Logger(PushAvulsosService.name);

  constructor(
    private readonly gateway: PushGateway,
    private readonly caixa: CaixaDeEntradaService,
    private readonly tokens: PushTokenService,
  ) {}

  /** `tipo` é o nome do job (rótulo da métrica de envio). */
  async enviar(
    tipo: string,
    mensagens: PushAvulso[],
    memoria: MemoriaDosAvulsos,
  ): Promise<AvulsosEnviados> {
    const progresso: ProgressoDosAvulsos = {
      resolvidos: [...(memoria.progresso?.resolvidos ?? [])],
      semHistorico: [...(memoria.progresso?.semHistorico ?? [])],
    };

    const pendentes = posicoesPendentes(mensagens.length, progresso);
    const aEnviar = pendentes.filter((i) =>
      this.gateway.tokenValido(mensagens[i]?.expoPushToken),
    );
    const invalidos = pendentes.length - aEnviar.length;

    let aceitos = 0;
    let recusados = 0;
    let falhas = 0;

    if (aEnviar.length > 0) {
      const resultados = await this.gateway.enviar(
        aEnviar.map((i) =>
          montarMensagemPush(
            mensagens[i].expoPushToken,
            mensagens[i].title,
            mensagens[i].body,
            mensagens[i].data,
          ),
        ),
      );
      ExpoPushClient.contar(tipo, resultados);

      const mortos: PushAvulso[] = [];
      resultados.forEach((resultado, k) => {
        const posicao = aEnviar[k];
        if (resultado.status === 'falha_transporte') {
          falhas++;
          return;
        }
        progresso.resolvidos.push(posicao);
        if (resultado.status === 'ok') {
          progresso.semHistorico.push(posicao);
          aceitos++;
        } else {
          recusados++;
          if (tokenMorto(resultado)) mortos.push(mensagens[posicao]);
        }
      });

      // Antes de qualquer outra escrita: se o job cair daqui em diante, a
      // nova tentativa já sabe quem não precisa receber de novo.
      await memoria.salvar(progresso);

      for (const morto of mortos) {
        await this.tokens.apagarSeAindaFor(morto.userId, morto.expoPushToken);
      }
    }

    if (progresso.semHistorico.length > 0) {
      await this.caixa.gravarVarias(
        progresso.semHistorico.map((i) => mensagens[i]),
      );
      progresso.semHistorico = [];
      await memoria.salvar(progresso);
    }

    if (falhas > 0) {
      // Só as posições sem resposta ficam pendentes para o retry do job.
      throw new IntegrationError({
        vendor: 'expo',
        tipo: 'indisponivel',
        detalhes: { tipo, falhas },
      });
    }

    if (recusados > 0 || invalidos > 0) {
      this.logger.warn(
        `[PUSH] ${tipo}: ${recusados} recusado(s) e ${invalidos} com token inválido, de ${mensagens.length}`,
      );
    }
    return { aceitos, recusados, invalidos };
  }
}

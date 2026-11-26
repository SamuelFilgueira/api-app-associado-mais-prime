import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  associadoSorteConfig,
  SORTE_BASES_CONTEMPLADAS,
} from 'src/associado-sorte/config/associado-sorte.config';
import {
  diaSaoPaulo,
  inicioDoDiaSaoPaulo,
} from 'src/associado-sorte/helpers/sorte-data.helper';
import {
  deveLembrarRaspada,
  dentroDaJanelaDeLembrete,
} from 'src/associado-sorte/helpers/sorte-raspadinha.helper';
import { SorteRaspadasRepository } from 'src/associado-sorte/repositories/sorte-raspadas.repository';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import {
  PushAvulso,
  emLotesDePush,
} from 'src/notifications/domain/push-avulsos';
import { comEnvelope } from 'src/queue/job-envelope';
import { PUSH_MASSA_QUEUE } from 'src/queue/queue.module';
import { baseTag } from 'src/shared/log.util';

/**
 * Lembrete programático "Sua raspadinha está liberada" (seção 2.7). Um passo
 * do job de 5 s: avisa cada inscrito com token de push que tem raspada no
 * dia, já cumpriu o intervalo e ainda não foi avisado DAQUELA liberação
 * (`SorteCarteira.lembreteRaspadaEm`). Fora da janela de envio, ninguém é
 * avisado; quando a janela abre, cada liberação pendente gera um único push.
 * Limita cada ciclo a um lote; o resto sai no ciclo seguinte.
 *
 * Os pushes vão para a fila de MASSA (`PUSH_MASSA_QUEUE`), em jobs de até
 * 100 mensagens — não para a fila de alerta, onde atrasavam o aviso de
 * ignição. O retry é o padrão da fila.
 */
@Injectable()
export class SorteLembreteRaspadaService {
  private readonly logger = new Logger(SorteLembreteRaspadaService.name);

  constructor(
    private readonly config: SorteConfigService,
    private readonly campanhas: SorteCampanhaService,
    private readonly repository: SorteRaspadasRepository,
    @InjectQueue(PUSH_MASSA_QUEUE) private readonly fila: Queue,
  ) {}

  /** Devolve quantos pushes entraram na fila. */
  async enviar(agora: Date = new Date()): Promise<number> {
    let total = 0;
    for (const baseOrigin of SORTE_BASES_CONTEMPLADAS) {
      try {
        total += await this.enviarDaBase(baseOrigin, agora);
      } catch (erro) {
        this.logger.error(
          `${baseTag(baseOrigin)} falha nos lembretes de raspadinha: ${(erro as Error).message}`,
        );
      }
    }
    return total;
  }

  private async enviarDaBase(baseOrigin: string, agora: Date): Promise<number> {
    const config = await this.config.obter(baseOrigin);
    if (!config.ativa || !config.lembretesAtivos) return 0;
    if (
      !dentroDaJanelaDeLembrete(
        agora,
        config.lembreteInicio,
        config.lembreteFim,
      )
    ) {
      return 0;
    }
    const campanha = await this.campanhas.publicadaDaBase(baseOrigin);
    if (
      !campanha ||
      agora.getTime() < campanha.inicio.getTime() ||
      agora.getTime() >= campanha.fim.getTime()
    ) {
      return 0;
    }

    const hoje = diaSaoPaulo(agora);
    const candidatos = await this.repository.listarCandidatosLembrete({
      baseOrigin,
      dia: hoje,
      inicioDoDia: inicioDoDiaSaoPaulo(hoje),
      agora,
      raspadasPorDia: config.raspadasPorDia,
      intervaloMinimoMinutos: config.intervaloMinimoMinutos,
      lote: associadoSorteConfig().lembreteRaspadaLote,
    });

    const mensagens: PushAvulso[] = [];
    for (const c of candidatos) {
      const { lembrar, liberacao } = deveLembrarRaspada({
        agora,
        raspadasHoje: c.raspadasHoje,
        ultimaRaspadaHojeEm: c.ultimaRaspadaHojeEm,
        raspadasPorDia: config.raspadasPorDia,
        intervaloMinimoMinutos: config.intervaloMinimoMinutos,
        lembreteRaspadaEm: c.lembreteRaspadaEm,
      });
      if (!lembrar) continue;
      // Reivindica antes de enfileirar: nunca dois pushes para a mesma liberação.
      const minha = await this.repository.reivindicarLembrete(
        c.userId,
        baseOrigin,
        liberacao,
      );
      if (!minha) continue;
      mensagens.push({
        userId: c.userId,
        expoPushToken: c.expoPushToken,
        title: 'Sua raspadinha está liberada 🍀',
        body: 'Raspe agora na Loja da Sorte e veja se ganhou um voucher em créditos.',
        data: { type: 'internal_route', screen: 'associado-da-sorte' },
      });
    }

    if (mensagens.length > 0) {
      await this.fila.addBulk(
        emLotesDePush(mensagens).map((lote) => ({
          name: 'sorte-lembrete-raspada',
          // `addBulk` não passa pelo `ProdutorDeFilas`: o envelope (base e
          // metadados de rastreio) é acrescentado aqui.
          data: comEnvelope({ mensagens: lote }, baseOrigin),
        })),
      );
      this.logger.log(
        `${baseTag(baseOrigin)} ${mensagens.length} lembrete(s) de raspadinha na fila`,
      );
    }
    return mensagens.length;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { resumirErros } from 'src/sga/helpers/resumo-de-erros.helper';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';

/** Revistorias tentadas por rodada (cada uma faz de 2 a 4 chamadas ao SGA). */
const LOTE = 20;

export interface ResultadoDaVarreduraDeRetry {
  /** Revistorias com tentativa vencida encontradas nesta rodada. */
  vencidas: number;
  gerados: number;
  reagendados: number;
  falhas: number;
  /** Outra tentativa chegou antes (lease) ou o estado mudou no caminho. */
  pulados: number;
}

/**
 * Varredura do retry do boleto de reativação: pega as revistorias em
 * `PENDENTE_RETRY` com `boletoProximaTentativaEm` vencido e dispara uma
 * tentativa para cada uma, em sequência.
 *
 * Substitui a cadeia de jobs atrasados (um por revistoria, que o próprio
 * job reagendava): o banco é a fonte da verdade do que falta tentar, então
 * reinício do processo ou Redis limpo não perdem nenhuma revistoria, e não
 * existe "segunda cadeia" para o mesmo boleto. O lease da geração garante
 * que duas varreduras (ou a varredura e um clique em "Gerar agora") nunca
 * cadastrem dois boletos.
 */
@Injectable()
export class BoletoRetryVarreduraService {
  private readonly logger = new Logger(BoletoRetryVarreduraService.name);

  constructor(
    private readonly revistorias: BoletoReativacaoRepository,
    private readonly gerar: GerarBoletoReativacaoService,
  ) {}

  async executar(
    agora: Date = new Date(),
  ): Promise<ResultadoDaVarreduraDeRetry> {
    const ids = await this.revistorias.listarRetriesVencidos(agora, LOTE);
    const resumo: ResultadoDaVarreduraDeRetry = {
      vencidas: ids.length,
      gerados: 0,
      reagendados: 0,
      falhas: 0,
      pulados: 0,
    };
    const erros: string[] = [];

    for (const reinspectionId of ids) {
      try {
        const r = await this.gerar.processar(reinspectionId, {
          origem: 'RETRY',
        });
        if (r.pulado) resumo.pulados += 1;
        else if (r.status === 'GERADO') resumo.gerados += 1;
        else if (r.status === 'PENDENTE_RETRY') resumo.reagendados += 1;
        else resumo.falhas += 1;
      } catch (error) {
        // Uma revistoria que nem o desfecho conseguiu gravar não pode impedir
        // as demais da rodada; a rodada termina como falha, com todas elas.
        erros.push(
          `revistoria ${reinspectionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (ids.length > 0) {
      this.logger.log(
        `Retry de boleto de reativação: ${resumo.vencidas} vencida(s), ${resumo.gerados} gerado(s), ${resumo.reagendados} reagendado(s), ${resumo.falhas} em falha, ${resumo.pulados} pulado(s), ${erros.length} com erro`,
      );
    }
    if (erros.length > 0) {
      throw new Error(
        `Retry de boleto de reativação: ${erros.length} de ${ids.length} tentativa(s) não concluíram — ${resumirErros(erros)}`,
      );
    }
    return resumo;
  }
}

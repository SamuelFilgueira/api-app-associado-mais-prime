import { Injectable } from '@nestjs/common';
import { BoletoReativacaoOrigem } from 'src/sga/domain/boleto-geracao';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';
import { BoletoReativacaoResultado } from 'src/sga/domain/boleto-resultado';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';

export type { BoletoReativacaoOrigem } from 'src/sga/domain/boleto-geracao';
export type { BoletoReativacaoResultado } from 'src/sga/domain/boleto-resultado';

/** Payload do job atrasado de retry (formato antigo, ainda no Redis). */
export interface BoletoReativacaoRetryJobData {
  reinspectionId: number;
  debugId?: string;
}

/**
 * Boleto de reativação após a aprovação da revistoria — fachada usada pelo
 * módulo de revistoria (aprovação e painel).
 *
 * A tentativa em si mora em `GerarBoletoReativacaoService` (lease, adoção,
 * cadastro, desfecho); o retry periódico, em `BoletoRetryVarreduraService`.
 */
@Injectable()
export class BoletoReativacaoService {
  constructor(
    private readonly gerar: GerarBoletoReativacaoService,
    private readonly revistorias: BoletoReativacaoRepository,
  ) {}

  /**
   * Uma tentativa de gerar o boleto. Nunca lança em erro de SGA/rede: o
   * desfecho vem no resultado (`GERADO`, `PENDENTE_RETRY`, `FALHA`, ou
   * `pulado` quando nada foi feito). Lança só em revistoria inexistente.
   */
  processar(
    reinspectionId: number,
    opcoes: { origem: BoletoReativacaoOrigem; debugId?: string },
  ): Promise<BoletoReativacaoResultado> {
    return this.gerar.processar(reinspectionId, opcoes);
  }

  /** Revistorias aguardando retry ou com falha definitiva (visão do painel). */
  listarPendentes() {
    return this.revistorias.listarPendentes();
  }
}

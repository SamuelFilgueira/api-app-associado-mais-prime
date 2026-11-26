import { Injectable } from '@nestjs/common';
import { DomainError } from 'src/shared/erros/erros';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { simularJanelas } from 'src/boleto-notificacao/domain/regua-janelas';
import {
  ResultadoMomento,
  todasEmCurso,
} from 'src/boleto-notificacao/domain/regua-resultado';
import {
  ExecutarReguaService,
  ExecutarRotinaOptions,
} from 'src/boleto-notificacao/services/executar-regua.service';

export const JOB_EXECUTAR_ROTINA = 'executar-rotina';
export { JOB_VERIFICAR_RECEIPTS } from 'src/boleto-notificacao/services/regua-etapa.service';
export type { ExecutarRotinaOptions } from 'src/boleto-notificacao/services/executar-regua.service';
export type {
  MetricasMomento,
  ResultadoMomento,
} from 'src/boleto-notificacao/domain/regua-resultado';

/** `code` da resposta 409 quando a régua pedida já está rodando. */
export const CODIGO_REGUA_EM_EXECUCAO = 'REGUA_EM_EXECUCAO';

/**
 * Régua diária de notificações push do ciclo de cobrança
 * (D-5 / D0 / D+1 / D+5 / D+6 / D+20 — documento do gestor, v. 10/09/2026),
 * ancorada no vencimento EFETIVO (`data_vencimento`, que o SGA já prorroga
 * para o próximo dia útil em fds/feriado) e alimentada pelo endpoint
 * POST /listar/boleto-associado/periodo do SGA.
 *
 * Fachada do módulo: o que o processor, o controller e o painel chamam. A
 * regra está em `domain/`; os casos de uso, em `ExecutarReguaService`
 * (bases e trava), `ReguaDaBaseService` (consulta única da base),
 * `ReguaEtapaService` (uma etapa), `ReguaSelecaoService` (quem recebe) e
 * `ReguaEnvioService` (envio e log).
 */
@Injectable()
export class BoletoNotificacaoService {
  constructor(
    private readonly regua: ExecutarReguaService,
    private readonly configService: BoletoNotificacaoConfigService,
  ) {}

  /**
   * Executa a rotina para as bases × etapas pedidas (uso do job, agendado ou
   * manual). Falha em uma base ou etapa não interrompe as demais: vem no
   * resultado. Base com outra execução em curso é pulada — depois de esperar
   * o tempo de uma trava sem dono expirar.
   */
  executarRotina(
    options: ExecutarRotinaOptions = {},
  ): Promise<ResultadoMomento[]> {
    return this.regua.executar(options, 'aguardar');
  }

  /**
   * Execução pedida pelo painel na própria requisição: não espera a trava.
   * Se NENHUMA base pôde rodar porque todas já têm execução em curso para a
   * data, responde 409 com `code` estável.
   */
  async executarManual(
    options: ExecutarRotinaOptions = {},
  ): Promise<ResultadoMomento[]> {
    const resultados = await this.regua.executar(options, 'desistir');
    if (todasEmCurso(resultados)) {
      throw new DomainError(
        CODIGO_REGUA_EM_EXECUCAO,
        'Já existe uma execução da régua em curso para esta base e data. Aguarde ela terminar.',
        {
          status: 409,
          detalhes: {
            dataReferencia: resultados[0].dataReferencia,
            bases: Array.from(new Set(resultados.map((r) => r.tenant))),
          },
        },
      );
    }
    return resultados;
  }

  /** Janelas de vencimento consultadas por etapa (apoio a testes/admin). */
  simularDatas(dataReferencia: Date) {
    return simularJanelas(dataReferencia, this.configService.get());
  }
}

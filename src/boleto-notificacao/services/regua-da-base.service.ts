import { Injectable, Logger } from '@nestjs/common';
import { baseTag } from 'src/shared/log.util';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { prepararBoletos } from 'src/boleto-notificacao/domain/regua-elegibilidade';
import {
  janelaDaEtapa,
  janelaDeConsulta,
} from 'src/boleto-notificacao/domain/regua-janelas';
import {
  ContextoDaRegua,
  resultadoDaEtapa,
  ResultadoMomento,
} from 'src/boleto-notificacao/domain/regua-resultado';
import { TipoMensagem } from 'src/boleto-notificacao/domain/regua-tipos';
import { ReguaExecucaoRepository } from 'src/boleto-notificacao/repositories/regua-execucao.repository';
import {
  DadosDaBase,
  ReguaEtapaService,
} from 'src/boleto-notificacao/services/regua-etapa.service';
import { SgaBoletoPeriodoClient } from 'src/boleto-notificacao/services/sga-boleto-periodo.client';

/**
 * Caso de uso: executar a régua de UMA base para uma data de referência.
 *
 * Uma única consulta ampla ao SGA (D-5 até o alcance do D+20) alimenta todas
 * as etapas: é o que a regra "só o fechamento mais recente por placa" exige,
 * e é o que mantém baixo o volume de chamadas à Hinova. Se a consulta falha
 * (inclusive bloqueio de token por extração), TODAS as etapas da base saem
 * como `FALHA` — nunca como "sem boletos". Falha dentro de uma etapa não
 * interrompe as demais.
 */
@Injectable()
export class ReguaDaBaseService {
  private readonly logger = new Logger(ReguaDaBaseService.name);

  constructor(
    private readonly configService: BoletoNotificacaoConfigService,
    private readonly sgaClient: SgaBoletoPeriodoClient,
    private readonly execucoes: ReguaExecucaoRepository,
    private readonly etapa: ReguaEtapaService,
  ) {}

  async executar(
    tenant: string,
    contexto: ContextoDaRegua,
  ): Promise<ResultadoMomento[]> {
    let dados: DadosDaBase;
    try {
      dados = await this.consultar(tenant, contexto.dataReferencia);
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      this.logger.error(
        `[BOLETO-NOTIF]${baseTag(tenant)} ❌ falha na consulta ao SGA: ${mensagem}`,
      );
      const falhas: ResultadoMomento[] = [];
      for (const tipo of contexto.tipos) {
        falhas.push(
          await this.registrarFalhaDeConsulta(tenant, tipo, contexto, mensagem),
        );
      }
      return falhas;
    }

    const resultados: ResultadoMomento[] = [];
    for (const tipo of contexto.tipos) {
      resultados.push(
        await this.etapa.processar(tenant, tipo, contexto, dados),
      );
    }
    return resultados;
  }

  /**
   * Consulta única da base: janela ampla, filtros de situação/tipo e a regra
   * "havendo mais de um boleto em aberto do mesmo tipo para a mesma placa,
   * vale só o mais recente".
   */
  private async consultar(
    tenant: string,
    dataReferencia: Date,
  ): Promise<DadosDaBase> {
    const config = this.configService.get();
    const janela = janelaDeConsulta(dataReferencia, config);

    const consulta = await this.sgaClient.listarAbertosPorVencimento(
      tenant,
      janela.inicio,
      janela.fim,
    );

    const { prontos, descartados } = prepararBoletos(
      consulta.boletos,
      config.codigosTipoBoleto,
    );
    if (descartados.length > 0) {
      this.logger.log(
        `[BOLETO-NOTIF]${baseTag(tenant)} ${descartados.length} boleto(s) em aberto ignorados por existir boleto mais recente da mesma placa (ex.: nosso_numero ${descartados[0]?.nossoNumero})`,
      );
    }

    return {
      origem: consulta.origem,
      paginasConsultadas: consulta.paginasConsultadas,
      brutos: consulta.boletos,
      prontos,
    };
  }

  /** Grava a execução `FALHA` de uma etapa quando a consulta da base cai. */
  private async registrarFalhaDeConsulta(
    tenant: string,
    tipo: TipoMensagem,
    contexto: ContextoDaRegua,
    erro: string,
  ): Promise<ResultadoMomento> {
    const janela = janelaDaEtapa(
      contexto.dataReferencia,
      tipo,
      this.configService.get(),
    );
    const resultado = resultadoDaEtapa(tenant, tipo, contexto, janela, {
      status: 'FALHA',
      erro,
    });
    if (!contexto.dryRun) {
      resultado.execucaoId = await this.execucoes.registrarFalhaDeConsulta(
        {
          tenant,
          tipo,
          dataReferencia: contexto.dataReferencia,
          dataAlvo: janela.fim,
          origem: contexto.origem,
        },
        erro,
      );
    }
    return resultado;
  }
}

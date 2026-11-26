import { Injectable, Logger } from '@nestjs/common';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { BOLETO_NOTIFICACAO_QUEUE } from 'src/queue/queue.module';
import { formatDateBR } from 'src/shared/date.util';
import { baseTag } from 'src/shared/log.util';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import {
  agruparPorAssociado,
  boletosNaJanela,
  Destinatario,
  elegiveisDaEtapa,
} from 'src/boleto-notificacao/domain/regua-elegibilidade';
import { janelaDaEtapa } from 'src/boleto-notificacao/domain/regua-janelas';
import {
  cobertura,
  ContextoDaRegua,
  MetricasMomento,
  resultadoDaEtapa,
  ResultadoMomento,
} from 'src/boleto-notificacao/domain/regua-resultado';
import { TipoMensagem } from 'src/boleto-notificacao/domain/regua-tipos';
import { mascararCpf } from 'src/boleto-notificacao/helpers/ciclo-cobranca.helper';
import { SgaBoletoPeriodo } from 'src/boleto-notificacao/interfaces/sga-boleto-periodo.interface';
import { ReguaExecucaoRepository } from 'src/boleto-notificacao/repositories/regua-execucao.repository';
import { ReguaEnvioService } from 'src/boleto-notificacao/services/regua-envio.service';
import { ReguaSelecaoService } from 'src/boleto-notificacao/services/regua-selecao.service';

export const JOB_VERIFICAR_RECEIPTS = 'verificar-receipts';

/** Resultado da consulta única da base, já filtrada e deduplicada. */
export interface DadosDaBase {
  origem: 'SGA' | 'MOCK';
  paginasConsultadas: number;
  /** Boletos crus da janela ampla (pós-parse, pré-filtros) — base da métrica. */
  brutos: SgaBoletoPeriodo[];
  /** ABERTOS + tipo permitido + dedupe "mais recente por placa". */
  prontos: SgaBoletoPeriodo[];
}

/**
 * Caso de uso: processar UMA etapa da régua (base × tipo) a partir da
 * consulta única da base — abre a execução, recorta os elegíveis, seleciona
 * quem recebe, envia e fecha a execução com as métricas.
 *
 * Erro dentro da etapa não escapa: a execução fica `FALHA`, com o erro, e o
 * resultado diz isso (as outras etapas da base seguem).
 */
@Injectable()
export class ReguaEtapaService {
  private readonly logger = new Logger(ReguaEtapaService.name);

  constructor(
    private readonly configService: BoletoNotificacaoConfigService,
    private readonly execucoes: ReguaExecucaoRepository,
    private readonly selecao: ReguaSelecaoService,
    private readonly envio: ReguaEnvioService,
    private readonly produtor: ProdutorDeFilas,
  ) {}

  async processar(
    tenant: string,
    tipo: TipoMensagem,
    contexto: ContextoDaRegua,
    dados: DadosDaBase,
  ): Promise<ResultadoMomento> {
    const config = this.configService.get();
    const janela = janelaDaEtapa(contexto.dataReferencia, tipo, config);
    const tag = `[BOLETO-NOTIF]${baseTag(tenant)}[${tipo}]`;
    const resultado = resultadoDaEtapa(tenant, tipo, contexto, janela);
    const metricas = resultado.metricas;

    const execucaoId = contexto.dryRun
      ? null
      : await this.execucoes.abrir({
          tenant,
          tipo,
          dataReferencia: contexto.dataReferencia,
          dataAlvo: janela.fim,
          origem: contexto.origem,
        });
    resultado.execucaoId = execucaoId;

    try {
      // 1. Recorte da janela da etapa sobre a consulta única da base
      resultado.origemDados = dados.origem;
      metricas.totalRegistrosSga = boletosNaJanela(dados.brutos, janela).length;
      metricas.totalPaginasSga = dados.paginasConsultadas;

      // 2. Elegíveis e grupos (1 push por associado × vencimento efetivo)
      const elegiveis = elegiveisDaEtapa(
        dados.prontos,
        janela,
        tipo,
        config.situacoesContratoSuspenso,
      );
      metricas.totalBoletosElegiveis = elegiveis.length;
      const { grupos, semIdentificacao } = agruparPorAssociado(elegiveis);
      metricas.totalAssociados = grupos.length;
      if (semIdentificacao > 0) {
        this.logger.warn(
          `${tag} ${semIdentificacao} boleto(s) sem codigo_associado/cpf válido foram ignorados`,
        );
        metricas.totalSemUsuario += semIdentificacao;
      }

      if (grupos.length === 0) {
        this.logger.log(
          `${tag} nenhum boleto ABERTO com vencimento efetivo em ${resultado.dataAlvo}`,
        );
        return await this.concluir(resultado, tag);
      }

      // 3. Quem recebe
      const selecao = await this.selecao.selecionar({
        tag,
        tenant,
        tipo,
        grupos,
        modelo: config.mensagens[tipo],
      });
      metricas.totalIdempotentes += selecao.idempotentes;
      metricas.totalSemUsuario += selecao.semUsuario;
      metricas.totalSemToken += selecao.semToken;
      metricas.totalDuplicadosUsuario += selecao.duplicadosUsuario;
      metricas.totalPendentes += selecao.emEnvio;

      this.logger.log(
        `${tag} elegíveis=${metricas.totalBoletosElegiveis} associados=${metricas.totalAssociados} ` +
          `semUsuario=${metricas.totalSemUsuario} semToken=${metricas.totalSemToken} ` +
          `idempotentes=${metricas.totalIdempotentes} duplicadosUsuario=${metricas.totalDuplicadosUsuario} → a enviar=${selecao.destinatarios.length}`,
      );
      if (selecao.emEnvio > 0) {
        this.logger.warn(
          `${tag} ${selecao.emEnvio} envio(s) ainda em andamento por outra execução (log ENFILEIRADO recente) — ficam pendentes`,
        );
      }

      if (execucaoId === null) {
        return this.simular(resultado, selecao.destinatarios);
      }

      // 4. Envio em lotes, com o log gravado antes e o desfecho depois
      await this.envio.enviar(
        { tag, tenant, tipo, execucaoId, destinatarios: selecao.destinatarios },
        metricas,
      );
      metricas.coberturaElegiveis = cobertura(
        metricas.totalEnfileirados,
        metricas.totalAssociados,
      );

      // 5. Recibos do Expo, mais tarde
      if (metricas.totalEnviados > 0) {
        await this.agendarVerificacaoDeRecibos(execucaoId, tenant);
      }

      return await this.concluir(resultado, tag);
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      this.logger.error(
        `${tag} ❌ falha: ${mensagem}`,
        erro instanceof Error ? erro.stack : undefined,
      );
      resultado.status = 'FALHA';
      resultado.erro = mensagem;
      if (execucaoId !== null) {
        this.cobrirEnfileirados(metricas);
        const registrada = await this.execucoes.falhar(
          execucaoId,
          mensagem,
          metricas,
        );
        if (!registrada) {
          this.logger.warn(
            `${tag} execução #${execucaoId} não estava EM_ANDAMENTO ao registrar a falha`,
          );
        }
      }
      return resultado;
    }
  }

  /** Dry-run: quem receberia, com os textos renderizados; nada é gravado. */
  private simular(
    resultado: ResultadoMomento,
    destinatarios: Destinatario[],
  ): ResultadoMomento {
    const metricas = resultado.metricas;
    metricas.totalEnfileirados = destinatarios.length;
    metricas.coberturaElegiveis = cobertura(
      destinatarios.length,
      metricas.totalAssociados,
    );
    resultado.status = 'DRY_RUN';
    resultado.amostraDestinatarios = destinatarios.slice(0, 20).map((d) => ({
      codigoAssociado: d.codigoAssociado,
      cpf: mascararCpf(d.cpf),
      userId: d.userId,
      quantidadeBoletos: d.boletos.length,
      nossoNumero: d.boletos[0]?.nossoNumero ?? '',
      vencimento: formatDateBR(d.vencimento),
      titulo: d.titulo,
      corpo: d.corpo,
    }));
    return resultado;
  }

  private async concluir(
    resultado: ResultadoMomento,
    tag: string,
  ): Promise<ResultadoMomento> {
    if (resultado.execucaoId === null) {
      resultado.status = 'DRY_RUN';
      return resultado;
    }
    resultado.status = 'CONCLUIDA';
    const concluida = await this.execucoes.concluir(
      resultado.execucaoId,
      resultado.metricas,
    );
    if (!concluida) {
      throw new Error(
        `${tag} execução #${resultado.execucaoId} não estava EM_ANDAMENTO ao concluir`,
      );
    }
    return resultado;
  }

  /** Falha no meio do envio: a cobertura sai do que já foi registrado. */
  private cobrirEnfileirados(metricas: MetricasMomento): void {
    if (
      metricas.coberturaElegiveis === null &&
      metricas.totalEnfileirados > 0
    ) {
      metricas.coberturaElegiveis = cobertura(
        metricas.totalEnfileirados,
        metricas.totalAssociados,
      );
    }
  }

  private async agendarVerificacaoDeRecibos(
    execucaoId: number,
    tenant: string,
  ): Promise<void> {
    const delay = this.configService.get().receiptsDelayMinutos * 60_000;
    // Tentativas, backoff e retenção vêm do padrão da fila (`filas.ts`).
    await this.produtor.enfileirar(
      BOLETO_NOTIFICACAO_QUEUE,
      JOB_VERIFICAR_RECEIPTS,
      { execucaoId, tentativa: 1 },
      {
        base: tenant,
        opcoes: {
          delay,
          jobId: `boleto-notificacao-receipts-${execucaoId}-1`,
        },
      },
    );
  }
}

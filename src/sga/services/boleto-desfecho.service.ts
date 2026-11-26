import { Injectable, Logger } from '@nestjs/common';
import { ReinspectionBoletoStatus } from '@prisma/client';
import { MailService } from 'src/infra/mail/mail.service';
import { metricas } from 'src/infra/observability/metricas';
import {
  BoletoReativacaoRetryConfig,
  getBoletoReativacaoRetryConfig,
} from 'src/sga/config/boleto-reativacao-retry.config';
import {
  decidirAposFalha,
  motivoDaFalha,
  truncarErro,
} from 'src/sga/domain/boleto-geracao';
import {
  BoletoPronto,
  BoletoReativacaoResultado,
  RevistoriaParaBoleto,
  TentativaDeBoleto,
  resultadoDoBoleto,
} from 'src/sga/domain/boleto-resultado';
import {
  BoletoCadastradoSemRegistroError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';
import { logDoBoleto } from 'src/sga/helpers/boleto-log.helper';
import { classificarErroDoBoleto } from 'src/sga/helpers/sga-instabilidade.helper';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';

/**
 * Desfecho de uma tentativa de gerar o boleto de reativação: grava o estado
 * final na revistoria, solta o lease e avisa quem precisa saber.
 *
 *  - sucesso: `GERADO` + e-mail de aprovação (só sai quando o boleto existe);
 *  - instabilidade comprovada dentro da janela: `PENDENTE_RETRY` com a
 *    próxima tentativa (a varredura de retry a retoma);
 *  - erro de regra, de dados ou inesperado, ou janela esgotada: `FALHA` +
 *    e-mail para a cobrança gerar à mão.
 *
 * Toda gravação é condicional ao lease: quem o perdeu não sobrescreve o
 * estado de quem assumiu.
 */
@Injectable()
export class BoletoDesfechoService {
  private readonly logger = new Logger(BoletoDesfechoService.name);
  private readonly config: BoletoReativacaoRetryConfig =
    getBoletoReativacaoRetryConfig();

  constructor(
    private readonly revistorias: BoletoReativacaoRepository,
    private readonly mailService: MailService,
  ) {}

  async sucesso(
    tentativa: TentativaDeBoleto,
    boleto: BoletoPronto,
  ): Promise<BoletoReativacaoResultado> {
    const { revistoria } = tentativa;
    const escrita = await this.revistorias.concluirGerado({
      reinspectionId: revistoria.id,
      dono: tentativa.dono,
      agora: tentativa.agora,
      tentativa: tentativa.numero,
      nossoNumero: boleto.nossoNumero,
      origem: boleto.adotado ? 'ADOTADO_SGA' : 'CRIADO_APP',
    });
    if (escrita !== 'COM_LEASE') {
      this.log(
        'error',
        tentativa,
        'Lease da geração perdido antes de gravar o boleto gerado',
        { nossoNumero: boleto.nossoNumero, escrita },
      );
    }

    metricas.boletoReativacao.inc({
      base: this.baseParaMetrica(revistoria),
      evento: 'gerado',
    });
    const emailEnviado = await this.enviarEmail(() =>
      this.mailService.sendRevistoriaAprovadaEmail(
        revistoria.userVehicle.chassi,
        revistoria.userVehicle.plate,
        tentativa.debugId,
        // Só existe quando a regra da empresa deixa algo para a equipe
        // (ex.: cancelar o boleto substituído); sem isso, a chamada de sempre.
        ...(boleto.pendencia ? [boleto.pendencia] : []),
      ),
    );
    if (boleto.pendencia) {
      this.log('warn', tentativa, 'Boleto gerado com pendência manual', {
        nossoNumero: boleto.nossoNumero,
        pendencia: boleto.pendencia,
        emailEnviado,
      });
    }

    this.log('log', tentativa, 'Boleto de reativação concluído', {
      nossoNumero: boleto.nossoNumero,
      adotado: boleto.adotado,
      tentativa: tentativa.numero,
      suriEnviada: boleto.suriEnviada,
      emailEnviado,
    });
    return resultadoDoBoleto(revistoria.id, {
      status: ReinspectionBoletoStatus.GERADO,
      adotado: boleto.adotado,
      nossoNumero: boleto.nossoNumero,
      linkBoleto: boleto.linkBoleto,
      tentativas: tentativa.numero,
      suriEnviada: boleto.suriEnviada,
      emailEnviado,
    });
  }

  /**
   * Só instabilidade comprovada (rede, timeout, 5xx, bloqueio da Hinova,
   * banco fora) entra no retry; erro de regra, de dados ou inesperado vai
   * direto para `FALHA`.
   *
   * `nossoNumeroCadastrado`: boleto que a API chegou a cadastrar no SGA —
   * fica gravado na revistoria para a tentativa seguinte retomar dele, em
   * vez de cadastrar outro.
   */
  async falha(
    tentativa: TentativaDeBoleto,
    error: unknown,
    nossoNumeroCadastrado: string | null = null,
  ): Promise<BoletoReativacaoResultado> {
    const { revistoria, agora } = tentativa;
    const semRegistro = error instanceof BoletoCadastradoSemRegistroError;
    const cadastrado = semRegistro
      ? error.boleto.nossoNumero
      : nossoNumeroCadastrado;

    const erroTipado = classificarErroDoBoleto(
      semRegistro ? error.causa : error,
    );
    const mensagem = truncarErro(
      cadastrado
        ? `Boleto ${cadastrado} JÁ CADASTRADO no SGA (não gere outro); a gravação local falhou: ${erroTipado.message}`
        : erroTipado.message,
    );
    const decisao = decidirAposFalha({
      instabilidade: erroTipado instanceof BoletoReativacaoInstabilidadeError,
      inicioDaJanela: tentativa.inicioDaJanela,
      agora,
      config: this.config,
    });

    if (decisao.acao === 'RETENTAR') {
      const gravou = await this.revistorias.agendarNovaTentativa({
        reinspectionId: revistoria.id,
        dono: tentativa.dono,
        agora,
        tentativa: tentativa.numero,
        proximaTentativaEm: decisao.proximaTentativaEm,
        inicioDaJanela: tentativa.inicioDaJanela,
        erro: mensagem,
        nossoNumeroCadastrado: cadastrado,
      });
      if (!gravou) return this.leasePerdido(tentativa, mensagem);

      this.log(
        'warn',
        tentativa,
        'Boleto de reativação adiado por instabilidade do SGA',
        {
          tentativa: tentativa.numero,
          proximaTentativaEm: decisao.proximaTentativaEm.toISOString(),
          erro: mensagem,
        },
      );
      return resultadoDoBoleto(revistoria.id, {
        status: ReinspectionBoletoStatus.PENDENTE_RETRY,
        nossoNumero: cadastrado,
        tentativas: tentativa.numero,
        proximaTentativaEm: decisao.proximaTentativaEm,
        erro: mensagem,
      });
    }

    const motivo = motivoDaFalha(mensagem, decisao.esgotou, this.config);
    const gravou = await this.revistorias.registrarFalha({
      reinspectionId: revistoria.id,
      dono: tentativa.dono,
      agora,
      tentativa: tentativa.numero,
      erro: truncarErro(motivo),
      nossoNumeroCadastrado: cadastrado,
    });
    if (!gravou) return this.leasePerdido(tentativa, motivo);

    metricas.boletoReativacao.inc({
      base: this.baseParaMetrica(revistoria),
      evento: 'falha_geracao',
    });
    const emailEnviado = await this.enviarEmail(() =>
      this.mailService.sendRevistoriaAprovadaSemBoletoEmail(
        revistoria.userVehicle.chassi,
        revistoria.userVehicle.plate,
        motivo,
        tentativa.debugId,
      ),
    );
    this.log('error', tentativa, 'Boleto de reativação não gerado', {
      tentativa: tentativa.numero,
      definitivo: !decisao.esgotou,
      erro: motivo,
      emailEnviado,
    });
    return resultadoDoBoleto(revistoria.id, {
      status: ReinspectionBoletoStatus.FALHA,
      nossoNumero: cadastrado,
      tentativas: tentativa.numero,
      erro: truncarErro(motivo),
      emailEnviado,
    });
  }

  /**
   * O lease venceu antes do desfecho e outra tentativa assumiu a revistoria:
   * o estado dela não é sobrescrito. Devolve o estado atual, como `pulado`.
   */
  private async leasePerdido(
    tentativa: TentativaDeBoleto,
    erro: string,
  ): Promise<BoletoReativacaoResultado> {
    const { revistoria } = tentativa;
    this.log(
      'error',
      tentativa,
      'Lease da geração perdido antes de gravar a falha; estado mantido',
      { erro },
    );
    const atual = await this.revistorias.carregar(revistoria.id);
    return resultadoDoBoleto(revistoria.id, {
      status: atual?.boletoStatus ?? revistoria.boletoStatus,
      pulado: true,
      nossoNumero: atual?.boletoNossoNumero ?? null,
      tentativas: atual?.boletoTentativas ?? tentativa.numero,
      proximaTentativaEm: atual?.boletoProximaTentativaEm ?? null,
      erro,
    });
  }

  /** O MailService já loga a falha com contexto; aqui o resultado leva `false`. */
  private async enviarEmail(enviar: () => Promise<void>): Promise<boolean> {
    try {
      await enviar();
      return true;
    } catch {
      return false;
    }
  }

  private baseParaMetrica(revistoria: RevistoriaParaBoleto): string {
    return revistoria.userVehicle.user?.baseOrigin ?? 'n/a';
  }

  private log(
    nivel: 'log' | 'warn' | 'error',
    tentativa: TentativaDeBoleto,
    mensagem: string,
    meta: Record<string, unknown> = {},
  ): void {
    logDoBoleto(
      this.logger,
      BoletoDesfechoService.name,
      nivel,
      {
        reinspectionId: tentativa.revistoria.id,
        baseOrigin: tentativa.revistoria.userVehicle.user?.baseOrigin,
        origem: tentativa.origem,
        debugId: tentativa.debugId,
      },
      mensagem,
      meta,
    );
  }
}

import { Injectable, Logger } from '@nestjs/common';
import {
  RegraEncargosPorAtraso,
  getRegraRevistoria,
} from 'src/config/revistoria-regra.config';
import { formatDateBR } from 'src/shared/date.util';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { debugLog } from 'src/shared/debug-log.util';
import { baseTag } from 'src/shared/log.util';
import { exigirBase } from 'src/shared/tenant/tenant-context';
import {
  BoletoReativacaoCriado,
  ConclusaoDoBoleto,
  RegistroDoBoleto,
  montarCadastroDoBoleto,
  valorBaseDoBoleto,
} from 'src/sga/domain/boleto-cadastro';
import {
  BoletoEmAberto,
  RegistroDeEncargos,
  calcularEncargos,
  diasDeAtraso,
  montarRegistroDeEncargos,
  paraCentavos,
  referenciaGravada,
} from 'src/sga/domain/boleto-encargos';
import { ProdutosDoVeiculo } from 'src/sga/domain/boleto-sga.parser';
import {
  BoletoCadastradoSemRegistroError,
  BoletoReativacaoDefinitivoError,
} from 'src/sga/errors/boleto-reativacao.error';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';

export type {
  BoletoReativacaoCriado,
  ConclusaoDoBoleto,
  RegistroDoBoleto,
} from 'src/sga/domain/boleto-cadastro';
import { suriTemplates } from 'src/config/integracoes.config';

/** Encargos calculados para o boleto que está sendo gerado. */
interface EncargosDoBoleto {
  totalCentavos: number;
  registro: RegistroDeEncargos;
  boletoAnterior: BoletoEmAberto | null;
}

/**
 * Criação do boleto de reativação no SGA e o que vem logo depois: gravar o
 * boleto (a linha que a varredura de pagamento acompanha), mudar a situação
 * do veículo e avisar o associado pelo WhatsApp com o link.
 *
 * Erros saem tipados: `BoletoReativacaoInstabilidadeError` (vale retry),
 * `BoletoReativacaoDefinitivoError` (não adianta repetir) e
 * `BoletoCadastradoSemRegistroError` (o boleto existe no SGA, a gravação
 * local falhou — quem chama não pode cadastrar outro).
 */
@Injectable()
export class BoletoCriacaoService {
  private readonly logger = new Logger(BoletoCriacaoService.name);

  constructor(
    private readonly client: SgaBoletoClient,
    private readonly pagamentos: PagamentoBoletoRepository,
    private readonly suriNotificacaoService: SuriNotificacaoService,
  ) {}

  async criarBoletoReativacao(
    userVehicleId: number,
    plate: string,
    debugId?: string,
    opcoes?: { reinspectionId?: number },
  ): Promise<BoletoReativacaoCriado> {
    // 1. CPF e base do dono do veículo. Sem base o boleto não é criado
    // (antes saía com a credencial e os códigos da base padrão).
    const dono = await this.pagamentos.donoDoVeiculo(userVehicleId);
    if (!dono?.cpf) {
      throw new BoletoReativacaoDefinitivoError(
        'CPF não encontrado para o veículo',
        'dados-locais',
      );
    }
    const cpf = dono.cpf.replace(/\D/g, '');
    const baseOrigin = exigirBase(dono.baseOrigin, 'boleto de reativação');
    // Códigos do SGA que variam por empresa (conta, tipo, situações).
    const regraBoleto = getRegraRevistoria(baseOrigin).boleto;

    // 2. Associado e produtos do veículo (valor, taxa, codigo_veiculo).
    const associado = await this.client.buscarDadosAssociadoParaBoleto(
      cpf,
      baseOrigin,
    );
    const produtos = await this.client.buscarProdutosDoVeiculo(
      plate,
      baseOrigin,
    );

    // 3. Encargos por atraso, só nas empresas cuja regra os cobra (hoje a
    // Hertz). Nas demais não há chamada a mais nem mudança de valor.
    const agora = new Date();
    const encargos = regraBoleto.encargosPorAtraso
      ? await this.calcularEncargosPorAtraso({
          baseOrigin,
          regra: regraBoleto.encargosPorAtraso,
          produtos,
          agora,
          userVehicleId,
          debugId,
        })
      : null;

    // 4. Cadastro no SGA. A descrição leva a referência da revistoria.
    const boleto = await this.client.cadastrarBoleto(
      baseOrigin,
      montarCadastroDoBoleto({
        associado,
        produtos,
        codigos: regraBoleto,
        agora,
        reinspectionId: opcoes?.reinspectionId,
        valorTotalCentavos: encargos?.totalCentavos,
      }),
    );
    if (!boleto.encontrado) {
      this.logger.error(
        `${baseTag(baseOrigin)} boleto/cadastrar respondeu 2xx sem os dados do boleto em nenhum formato conhecido | userVehicleId=${userVehicleId} | rawBody=${JSON.stringify(boleto.cru)}`,
      );
    }
    const { nossoNumero, linhaDigitavel, linkBoleto } = boleto;
    const codigoVeiculo = produtos.codigoVeiculo ?? null;

    // 5. O boleto novo substitui o que estava em aberto: cancela o antigo.
    // Falha aqui não desfaz o boleto novo — vira pendência para a equipe.
    const pendencia = encargos
      ? await this.cancelarBoletoSubstituido({
          baseOrigin,
          encargos,
          nossoNumeroNovo: nossoNumero,
          agora,
          userVehicleId,
          debugId,
        })
      : null;

    // 6. Gravação local. A partir daqui o boleto EXISTE no SGA: se a
    // gravação falhar, o erro carrega o boleto para ninguém cadastrar outro.
    try {
      await this.registrarPagamentoBoleto({
        userVehicleId,
        reinspectionId: opcoes?.reinspectionId,
        nossoNumero,
        linhaDigitavel,
        linkBoleto,
        debugId,
        baseOrigin,
        codigoVeiculo,
        associado,
        encargos: encargos?.registro,
      });
    } catch (error) {
      throw new BoletoCadastradoSemRegistroError(
        { nossoNumero, linhaDigitavel, linkBoleto },
        error,
      );
    }

    // 7. Situação do veículo após o boleto (Mais Prime: 20 — aguardando
    // reativação; empresas sem equivalente: não altera).
    const situacaoVeiculoAlterada = await this.aplicarSituacaoAposBoleto(
      baseOrigin,
      codigoVeiculo,
      regraBoleto.situacaoVeiculoAposBoleto,
    );

    // O app precisa enxergar o boleto novo e a situação nova já na próxima
    // abertura, não só quando o cache das leituras vencer.
    await this.client.invalidarLeituras(baseOrigin, { cpf, codigoVeiculo });

    // 8. WhatsApp com o link.
    const concluido = await this.concluirBoletoReativacao({
      userVehicleId,
      baseOrigin,
      nossoNumero,
      linkBoleto,
      codigoVeiculo,
      associado,
      debugId,
    });

    return {
      nossoNumero,
      linhaDigitavel,
      linkBoleto,
      codigoVeiculo,
      codigoAssociado: associado.codigoAssociado,
      pollerAgendado: concluido.pollerAgendado,
      suriEnviada: concluido.suriEnviada,
      situacaoVeiculoAlterada,
      encargos: encargos?.registro ?? null,
      pendencia,
    };
  }

  /**
   * Valor do boleto com multa e mora, pela regra da empresa: localiza o
   * último boleto em aberto do veículo e conta o atraso a partir do
   * vencimento dele. Sem boleto em aberto, o boleto sai pelo valor base.
   *
   * Se o boleto em aberto já é um boleto de reativação que esta API gerou
   * com encargos, vale a data de referência gravada com ele: o atraso não
   * recomeça do zero quando um boleto de reativação vence sem pagamento.
   *
   * Qualquer falha aqui IMPEDE a geração (erro tipado, como nas demais
   * etapas): boleto sem os encargos devidos é cobrança errada.
   */
  private async calcularEncargosPorAtraso(params: {
    baseOrigin: BaseOrigin;
    regra: RegraEncargosPorAtraso;
    produtos: ProdutosDoVeiculo;
    agora: Date;
    userVehicleId: number;
    debugId?: string;
  }): Promise<EncargosDoBoleto> {
    const { baseOrigin, regra, produtos, agora } = params;
    const etapa = 'encargos-por-atraso';

    const baseCentavos = paraCentavos(valorBaseDoBoleto(produtos));
    if (!Number.isFinite(baseCentavos) || baseCentavos <= 0) {
      throw new BoletoReativacaoDefinitivoError(
        `Valor base do boleto inválido (${String(valorBaseDoBoleto(produtos))}): não é possível calcular os encargos`,
        etapa,
      );
    }
    if (!produtos.codigoVeiculo) {
      throw new BoletoReativacaoDefinitivoError(
        'codigo_veiculo ausente nos produtos do veículo: não é possível localizar o boleto em aberto para calcular os encargos',
        etapa,
      );
    }

    const hoje = new Date(agora);
    hoje.setHours(0, 0, 0, 0);
    const boletoAnterior = await this.client.buscarUltimoBoletoEmAberto(
      baseOrigin,
      produtos.codigoVeiculo,
      hoje,
    );

    let vencimentoDeReferencia = boletoAnterior?.vencimento ?? null;
    if (boletoAnterior) {
      const gravada = referenciaGravada(
        await this.pagamentos.encargosDoBoleto(boletoAnterior.nossoNumero),
      );
      if (gravada && gravada.getTime() < boletoAnterior.vencimento.getTime()) {
        vencimentoDeReferencia = gravada;
      }
    }

    const calculo = calcularEncargos({
      baseCentavos,
      dias: vencimentoDeReferencia
        ? diasDeAtraso(vencimentoDeReferencia, hoje)
        : 0,
      regra,
    });
    const registro = montarRegistroDeEncargos({
      regra,
      calculo,
      boletoAnterior,
      vencimentoDeReferencia,
    });

    this.logger.log(
      debugLog(
        BoletoCriacaoService.name,
        `${baseTag(baseOrigin)} Encargos por atraso do boleto de reativação`,
        params.debugId,
        {
          userVehicleId: params.userVehicleId,
          codigoVeiculo: produtos.codigoVeiculo,
          boletoEmAberto: boletoAnterior?.nossoNumero ?? 'nenhum',
          vencimentoDoBoletoEmAberto: registro.boletoAnterior?.vencimento,
          vencimentoDeReferencia: registro.vencimentoDeReferencia,
          diasDeAtraso: calculo.diasDeAtraso,
          // Conferência: o SGA também informa os dias vencidos do boleto.
          diasVencidosNoSga: boletoAnterior?.diasVencidosNoSga,
          valorBase: registro.valorBase,
          multa: registro.multa,
          mora: registro.mora,
          valorTotal: registro.valorTotal,
        },
      ),
    );
    return { totalCentavos: calculo.totalCentavos, registro, boletoAnterior };
  }

  /**
   * Cancela no SGA o boleto em aberto que o de reativação substituiu e
   * anota o desfecho na memória de cálculo. Devolve o texto da pendência
   * para a equipe quando o cancelamento não aconteceu; `null` se não havia
   * o que cancelar ou se o SGA cancelou.
   *
   * Não lança: o boleto novo já existe.
   */
  private async cancelarBoletoSubstituido(params: {
    baseOrigin: BaseOrigin;
    encargos: EncargosDoBoleto;
    nossoNumeroNovo: string | null;
    agora: Date;
    userVehicleId: number;
    debugId?: string;
  }): Promise<string | null> {
    const { baseOrigin, encargos, agora } = params;
    const anterior = encargos.boletoAnterior;
    const regra = getRegraRevistoria(baseOrigin).boleto.encargosPorAtraso;
    if (!anterior || !regra?.cancelarBoletoEmAberto) return null;

    let resultado: { cancelado: boolean; motivo: string | null };
    try {
      resultado = await this.client.cancelarBoleto(
        baseOrigin,
        anterior.nossoNumero,
      );
    } catch (error) {
      resultado = {
        cancelado: false,
        motivo: error instanceof Error ? error.message : String(error),
      };
    }

    encargos.registro.cancelamento = {
      situacao: resultado.cancelado ? 'CANCELADO' : 'PENDENTE_MANUAL',
      motivo: resultado.motivo,
      em: agora.toISOString(),
    };
    if (resultado.cancelado) return null;

    const pendencia =
      `Cancelar manualmente no SGA o boleto ${anterior.nossoNumero} ` +
      `(vencimento ${formatDateBR(anterior.vencimento)}): ele foi substituído pelo boleto de reativação ` +
      `${params.nossoNumeroNovo ?? '(sem número)'}, de R$ ${encargos.registro.valorTotal.replace('.', ',')} ` +
      `(base R$ ${encargos.registro.valorBase.replace('.', ',')} + multa R$ ${encargos.registro.multa.replace('.', ',')} ` +
      `+ mora R$ ${encargos.registro.mora.replace('.', ',')} por ${encargos.registro.diasDeAtraso} dia(s) de atraso).`;
    this.logger.error(
      debugLog(
        BoletoCriacaoService.name,
        `${baseTag(baseOrigin)} Boleto em aberto NÃO cancelado no SGA: cancelamento manual pendente`,
        params.debugId,
        {
          userVehicleId: params.userVehicleId,
          boletoACancelar: anterior.nossoNumero,
          boletoNovo: params.nossoNumeroNovo ?? 'N/A',
          motivo: resultado.motivo,
        },
      ),
    );
    return pendencia;
  }

  /**
   * Grava/atualiza o `ReinspectionPayment` do boleto. Com `nosso_numero`,
   * código do veículo e base, a linha já entra na varredura de pagamento
   * (é ela que substitui o job repetível por boleto).
   *
   * LANÇA se a gravação falhar: boleto sem linha é boleto que ninguém
   * verifica — o associado paga e o veículo não é reativado.
   */
  async registrarPagamentoBoleto(params: RegistroDoBoleto): Promise<void> {
    const verificavel =
      !!params.nossoNumero && !!params.codigoVeiculo && !!params.baseOrigin;

    await this.pagamentos.registrarBoleto({
      userVehicleId: params.userVehicleId,
      reinspectionId: params.reinspectionId,
      nossoNumero: params.nossoNumero,
      linhaDigitavel: params.linhaDigitavel,
      linkBoleto: params.linkBoleto,
      agora: new Date(),
      encargos: params.encargos,
      verificacao: verificavel
        ? {
            baseOrigin: params.baseOrigin,
            codigoVeiculo: params.codigoVeiculo,
            codigoAssociado: params.associado?.codigoAssociado,
            nomeAssociado: params.associado?.nome,
            telefoneAssociado: params.associado?.telefoneCelular,
          }
        : undefined,
    });
  }

  /**
   * Etapa final comum ao boleto cadastrado pela API e ao boleto adotado:
   * envia o template Suri com o link. A verificação de pagamento não é mais
   * agendada aqui — ela nasce com a linha gravada em
   * `registrarPagamentoBoleto`; `pollerAgendado` só informa se o boleto tem
   * o que a varredura precisa.
   *
   * Não lança: o boleto já existe, e a falha do aviso volta no resultado.
   */
  async concluirBoletoReativacao(
    params: ConclusaoDoBoleto,
  ): Promise<{ pollerAgendado: boolean; suriEnviada: boolean }> {
    const meta = {
      userVehicleId: params.userVehicleId,
      nossoNumero: params.nossoNumero ?? 'N/A',
    };

    const pollerAgendado = !!params.nossoNumero && !!params.codigoVeiculo;
    if (!pollerAgendado) {
      this.logger.error(
        debugLog(
          BoletoCriacaoService.name,
          'Verificação de pagamento NÃO agendada: nosso_numero ou codigo_veiculo ausente',
          params.debugId,
          { ...meta, codigoVeiculo: params.codigoVeiculo ?? 'N/A' },
        ),
      );
    }

    if (!params.linkBoleto) {
      this.logger.warn(
        debugLog(
          BoletoCriacaoService.name,
          'link_boleto não encontrado; notificação Suri não enviada',
          params.debugId,
          meta,
        ),
      );
      return { pollerAgendado, suriEnviada: false };
    }

    try {
      await this.suriNotificacaoService.enviarTemplate({
        nome: params.associado.nome ?? '',
        telefoneCelular: params.associado.telefoneCelular ?? '',
        templateId: suriTemplates().boletoDeReativacao,
        parametrosExtras: [params.linkBoleto],
        contexto: 'boleto-reativacao',
        debugId: params.debugId,
      });
      return { pollerAgendado, suriEnviada: true };
    } catch (suriError) {
      this.logger.error(
        debugLog(
          BoletoCriacaoService.name,
          'Falha ao enviar notificação Suri',
          params.debugId,
          {
            ...meta,
            error:
              suriError instanceof Error
                ? suriError.message
                : String(suriError),
          },
        ),
      );
      return { pollerAgendado, suriEnviada: false };
    }
  }

  /**
   * Coloca o veículo na situação que a regra da base define para depois do
   * boleto. Falha aqui não desfaz o boleto: volta `false` no resultado.
   */
  async aplicarSituacaoAposBoleto(
    baseOrigin: BaseOrigin,
    codigoVeiculo: string | null | undefined,
    situacao: number | null,
  ): Promise<boolean | null> {
    if (!codigoVeiculo || situacao == null) return null;

    let motivo: string;
    try {
      const resposta = await this.client.alterarSituacaoDoVeiculo(
        baseOrigin,
        situacao,
        codigoVeiculo,
      );
      if (resposta.status < 400) return true;
      motivo = `HTTP ${resposta.status} ${JSON.stringify(resposta.data)}`;
    } catch (error) {
      motivo = error instanceof Error ? error.message : String(error);
    }
    this.logger.error(
      `${baseTag(baseOrigin)} Falha ao alterar situação do veículo para ${situacao} | codigo_veiculo=${codigoVeiculo} | ${motivo}`,
    );
    return false;
  }
}

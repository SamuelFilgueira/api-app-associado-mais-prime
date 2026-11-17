import { Injectable } from '@nestjs/common';
import { TENANT } from 'src/config/tenant.config';
import {
  associadoSorteConfig,
  SORTE_BASES_CONTEMPLADAS,
} from 'src/associado-sorte/config/associado-sorte.config';
import {
  SORTE_BASE_LABELS,
  SORTE_CAMPANHA_ESTADO_LABELS,
  SORTE_INSCRICAO_FONTE_LABELS,
  SORTE_MOMENTO_STATUS_LABELS,
  SORTE_NOTIFICACAO_TIPO_LABELS,
  SORTE_ORIGEM_LABELS,
  SORTE_PRODUTO_TIPO_LABELS,
  SORTE_RASPADA_RESULTADO_LABELS,
  SORTE_TENTATIVA_ACAO_LABELS,
  SORTE_ESTADO_LABELS,
  SORTE_FASE_LABELS,
  SORTE_FONTE_LABELS,
  SORTE_LANCAMENTO_LABELS,
  SORTE_MECANICA_LABELS,
  SORTE_MODO_CREDITO_LABELS,
  SORTE_MOVIMENTO_LABELS,
  SORTE_SITUACAO_LABELS,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import { diaSaoPaulo } from 'src/associado-sorte/helpers/sorte-data.helper';
import {
  toCampanhaAdmin,
  toGanhadorAdmin,
  toPremioAdmin,
  toRodadaAdmin,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteCampanhasRepository } from 'src/associado-sorte/repositories/sorte-campanhas.repository';
import { SorteInscricoesRepository } from 'src/associado-sorte/repositories/sorte-inscricoes.repository';
import { SorteNotificacoesAdminRepository } from 'src/associado-sorte/repositories/sorte-notificacoes-admin.repository';
import { SorteRaspadasRepository } from 'src/associado-sorte/repositories/sorte-raspadas.repository';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SortePremiosRepository } from 'src/associado-sorte/repositories/sorte-premios.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';

const opcoes = (rotulos: Record<string, string>) =>
  Object.entries(rotulos).map(([value, label]) => ({ value, label }));

/** Opções dos formulários e indicadores da visão geral do painel. */
@Injectable()
export class SorteDashboardService {
  constructor(
    private readonly config: SorteConfigService,
    private readonly creditosRepository: SorteCreditosRepository,
    private readonly rodadasRepository: SorteRodadasRepository,
    private readonly premiosRepository: SortePremiosRepository,
    private readonly ganhadoresRepository: SorteGanhadoresRepository,
    private readonly campanhasRepository: SorteCampanhasRepository,
    private readonly raspadasRepository: SorteRaspadasRepository,
    private readonly inscricoesRepository: SorteInscricoesRepository,
    private readonly notificacoesRepository: SorteNotificacoesAdminRepository,
  ) {}

  /** O painel lista todas as bases do deploy, não só a do operador. */
  opcoes() {
    return {
      bases: TENANT.baseNames.map((value) => ({
        value,
        label: SORTE_BASE_LABELS[value] ?? value,
      })),
      mecanicas: opcoes(SORTE_MECANICA_LABELS),
      modosCredito: opcoes(SORTE_MODO_CREDITO_LABELS),
      estados: opcoes(SORTE_ESTADO_LABELS),
      fases: opcoes(SORTE_FASE_LABELS),
      fontesCredito: opcoes(SORTE_FONTE_LABELS),
      situacoesGanhador: opcoes(SORTE_SITUACAO_LABELS),
      tiposMovimentoEstoque: opcoes(SORTE_MOVIMENTO_LABELS),
      tiposLancamento: opcoes(SORTE_LANCAMENTO_LABELS),
      // v2
      basesContempladas: [...SORTE_BASES_CONTEMPLADAS],
      tiposProduto: opcoes(SORTE_PRODUTO_TIPO_LABELS),
      origensGanhador: opcoes(SORTE_ORIGEM_LABELS),
      estadosCampanha: opcoes(SORTE_CAMPANHA_ESTADO_LABELS),
      statusMomento: opcoes(SORTE_MOMENTO_STATUS_LABELS),
      resultadosRaspada: opcoes(SORTE_RASPADA_RESULTADO_LABELS),
      fontesInscricao: opcoes(SORTE_INSCRICAO_FONTE_LABELS),
      acoesTentativa: opcoes(SORTE_TENTATIVA_ACAO_LABELS),
      tiposNotificacao: opcoes(SORTE_NOTIFICACAO_TIPO_LABELS),
      estoqueBaixo: associadoSorteConfig().estoqueBaixo,
    };
  }

  /** Indicadores da base selecionada no painel. */
  async dashboard(baseOrigin: string) {
    const agora = new Date();
    const limites = associadoSorteConfig();
    const hoje = diaSaoPaulo(agora);
    const [
      config,
      raspadasHoje,
      vouchersHoje,
      campanha,
      inscritos,
      creditosEmCirculacao,
      notificacoesNaoLidas,
      associadosComSaldo,
      creditosDistribuidos,
      creditosGastos,
      proximasRodadas,
      estoqueBaixo,
      aguardandoContato,
      listaAguardando,
    ] = await Promise.all([
      this.config.obter(baseOrigin),
      this.raspadasRepository.contarDoDia(baseOrigin, hoje),
      this.raspadasRepository.contarVouchersDoDia(baseOrigin, hoje),
      this.campanhasRepository.publicadaDaBase(baseOrigin),
      this.inscricoesRepository.contarInscritos(baseOrigin),
      this.creditosRepository.somarSaldos(baseOrigin),
      this.notificacoesRepository.contarNaoLidas(baseOrigin),
      this.creditosRepository.contarCarteirasComSaldo(baseOrigin),
      this.creditosRepository.somarCreditosDistribuidos(baseOrigin),
      this.creditosRepository.somarCreditosGastos(baseOrigin),
      this.rodadasRepository.listarProximas(baseOrigin, agora, 6),
      this.premiosRepository.listarEstoqueBaixo(limites.estoqueBaixo),
      this.ganhadoresRepository.contarAguardandoContato(baseOrigin),
      this.ganhadoresRepository.listarAguardandoContato(baseOrigin, 6),
    ]);
    const reservado = await this.premiosRepository.reservadoPorPremio(
      estoqueBaixo.map((p) => p.id),
    );
    const contagem = campanha
      ? (
          await this.campanhasRepository.contarMomentos([campanha.id], agora)
        ).get(campanha.id)
      : undefined;

    return {
      serverNow: agora,
      baseOrigin,
      promocaoAtiva: config.ativa,
      baseContemplada: SORTE_BASES_CONTEMPLADAS.includes(baseOrigin),
      rodadasHabilitadas: config.rodadasHabilitadas,
      // v2
      raspadasHoje,
      vouchersHoje,
      inscritos,
      /** Campanha publicada da base, com a contagem dos momentos. */
      campanha: campanha ? toCampanhaAdmin(campanha, contagem) : null,
      vouchersSaidos: contagem?.ganhos ?? 0,
      /** Já liberados e ainda sem ganhador. */
      vouchersPendentes: contagem?.disponiveis ?? 0,
      /** Ainda não chegaram no horário. */
      vouchersAguardando: contagem?.aguardando ?? 0,
      creditosEmCirculacao,
      notificacoesNaoLidas,
      retiradasAguardandoContato: aguardandoContato,
      // piloto
      fonteCreditoDiario: config.fonteCreditoDiario,
      associadosComSaldo,
      creditosDistribuidos,
      /** Debitado em participações e resgates, já sem os estornos. */
      creditosGastos,
      proximasRodadas: proximasRodadas.map((r) => toRodadaAdmin(r, agora)),
      premiosEstoqueBaixo: estoqueBaixo.map((p) =>
        toPremioAdmin(p, reservado.get(p.id) ?? 0),
      ),
      ganhadoresAguardandoContato: aguardandoContato,
      ganhadoresAguardando: listaAguardando.map(toGanhadorAdmin),
    };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  associadoSorteConfig,
  baseContemplada,
} from 'src/associado-sorte/config/associado-sorte.config';
import { linkWhatsapp } from 'src/associado-sorte/helpers/sorte.helpers';
import { SorteFase } from 'src/associado-sorte/enums/associado-sorte.enums';
import {
  MinhaSituacaoNaRodada,
  SITUACAO_VAZIA,
  toGanhadorPublico,
  toMeuPremio,
  toRodadaApp,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteInscricaoService } from 'src/associado-sorte/services/sorte-inscricao.service';
import { SorteRaspadinhaService } from 'src/associado-sorte/services/sorte-raspadinha.service';

/** Ordem de exibição das rodadas na tela inicial. */
const ORDEM_DAS_FASES: Record<SorteFase, number> = {
  ABERTA: 0,
  EM_BREVE: 1,
  APURANDO: 2,
  ESGOTADA: 3,
  ENCERRADA: 4,
};

/** Leituras compostas do app (tela inicial, detalhe da rodada, regulamento). */
@Injectable()
export class SorteAppService {
  constructor(
    private readonly config: SorteConfigService,
    private readonly creditosRepository: SorteCreditosRepository,
    private readonly rodadasRepository: SorteRodadasRepository,
    private readonly ganhadoresRepository: SorteGanhadoresRepository,
    private readonly raspadinha: SorteRaspadinhaService,
    private readonly ganhadores: SorteGanhadoresService,
    private readonly inscricao: SorteInscricaoService,
    private readonly campanhas: SorteCampanhaService,
  ) {}

  /**
   * Tudo que a tela inicial precisa em uma chamada (contrato v2). Base fora
   * de `SORTE_BASES_CONTEMPLADAS` ou promoção desligada: `{ ativa: false }`.
   * Não inscrito: `inscrito: false`, `motivo` e o convite (wa.me), sem
   * raspadinha nem campanha. Esta rota NÃO exige inscrição.
   */
  async resumo(userId: number, baseOrigin: string) {
    const agora = new Date();
    const config = baseContemplada(baseOrigin)
      ? await this.config.obter(baseOrigin).catch(() => null)
      : null;
    if (!config?.ativa) return { ativa: false as const, serverNow: agora };

    const convite = {
      whatsapp: config.whatsappConvite,
      mensagem: config.mensagemConvite,
      link: linkWhatsapp(config.whatsappConvite, config.mensagemConvite),
    };
    const usuario = await this.creditosRepository.buscarUsuario(userId);
    const inscricao = usuario?.isActive
      ? await this.inscricao.situacao(userId, baseOrigin, config)
      : null;
    const carteira = await this.creditosRepository.buscarCarteira(userId);
    const base = {
      ativa: true as const,
      serverNow: agora,
      titulo: config.titulo,
      subtitulo: config.subtitulo,
      convite,
      saldo: carteira?.saldo ?? 0,
      whatsappSuporte: config.whatsappSuporte,
    };

    if (!inscricao?.inscrito) {
      const motivo = !usuario?.isActive
        ? ('NAO_INSCRITO' as const)
        : (inscricao?.motivo ?? ('NAO_INSCRITO' as const));
      return {
        ...base,
        inscrito: false as const,
        motivo,
        totalGanho: carteira?.totalGanho ?? 0,
        raspadinha: null,
        jornada: null,
        campanha: null,
        premiosPendentes: [],
        rodadasHabilitadas: false,
        rodadas: [],
      };
    }

    const [estado, campanha, pendentes, rodadas] = await Promise.all([
      this.raspadinha.estado({ userId, config, carteira, agora }),
      this.campanhas.publicadaDaBase(baseOrigin),
      this.ganhadoresRepository.listarPendentesDoAssociado(userId),
      config.rodadasHabilitadas
        ? this.rodadasDoResumo(userId, baseOrigin, agora)
        : Promise.resolve([]),
    ]);
    const noPeriodo =
      !!campanha &&
      agora.getTime() >= campanha.inicio.getTime() &&
      agora.getTime() < campanha.fim.getTime();

    return {
      ...base,
      inscrito: true as const,
      motivo: null,
      totalGanho: carteira?.totalGanho ?? 0,
      raspadinha: {
        ...estado.raspadinha,
        /** Pode raspar agora: campanha no período e nenhum bloqueio. */
        disponivel: noPeriodo && estado.raspadinha.bloqueio === null,
        indisponivelMotivo: !campanha
          ? ('SEM_CAMPANHA' as const)
          : !noPeriodo
            ? ('CAMPANHA_FORA_DO_PERIODO' as const)
            : estado.raspadinha.bloqueio,
      },
      jornada: estado.jornada,
      campanha: campanha
        ? {
            id: campanha.id,
            nome: campanha.nome,
            inicio: campanha.inicio,
            fim: campanha.fim,
            noPeriodo,
          }
        : null,
      premiosPendentes: pendentes.map((g) =>
        toMeuPremio(g, config.whatsappSuporte),
      ),
      rodadasHabilitadas: config.rodadasHabilitadas,
      rodadas,
    };
  }

  /** Rodadas do piloto (só com `rodadasHabilitadas`). */
  private async rodadasDoResumo(
    userId: number,
    baseOrigin: string,
    agora: Date,
  ) {
    const limites = associadoSorteConfig();
    const rodadas = await this.rodadasRepository.listarApp({
      baseOrigin,
      encerradasDesde: new Date(
        agora.getTime() - limites.encerradasRecentesHoras * 3_600_000,
      ),
      limite: limites.rodadasResumoLimite,
    });
    const situacoes = await this.situacoes(
      rodadas.map((r) => r.id),
      userId,
    );
    return rodadas
      .map((r) => toRodadaApp(r, agora, situacoes.get(r.id)))
      .sort(
        (a, b) =>
          ORDEM_DAS_FASES[a.fase] - ORDEM_DAS_FASES[b.fase] ||
          a.abertura.getTime() - b.abertura.getTime(),
      );
  }

  /** Detalhe da rodada e do prêmio, com a situação do próprio associado. */
  async detalharRodada(id: number, userId: number, baseOrigin: string) {
    const config = await this.config.exigirAtiva(baseOrigin);
    const rodada = await this.rodadasRepository.buscarApp(id, baseOrigin);
    if (!rodada) throw new NotFoundException('Rodada não encontrada');

    const agora = new Date();
    const [carteira, situacoes, ganhadores, emCarenciaAte] = await Promise.all([
      this.creditosRepository.buscarCarteira(userId),
      this.situacoes([id], userId),
      config.exibirGanhadores
        ? this.ganhadoresRepository.listarDaRodada(id)
        : Promise.resolve([]),
      this.ganhadores.emCarenciaAte(userId, config, agora),
    ]);

    return {
      serverNow: agora,
      saldo: carteira?.saldo ?? 0,
      emCarenciaAte,
      rodada: toRodadaApp(rodada, agora, situacoes.get(id)),
      ganhadores: ganhadores
        .filter((g) => g.situacao !== 'CANCELADO')
        .map(toGanhadorPublico),
    };
  }

  /** Regulamento: não exige inscrição (o convidado pode ler). */
  async regulamento(baseOrigin: string) {
    const config = await this.config.exigirAtiva(baseOrigin);
    return {
      titulo: config.titulo,
      regulamento: config.regulamento ?? '',
      atualizadoEm: config.regulamentoAtualizadoEm,
    };
  }

  private async situacoes(
    rodadaIds: number[],
    userId: number,
  ): Promise<Map<number, MinhaSituacaoNaRodada>> {
    const { participacoes, ganhadores, lembretes } =
      await this.rodadasRepository.situacaoDoAssociado(rodadaIds, userId);
    const mapa = new Map<number, MinhaSituacaoNaRodada>();
    const obter = (rodadaId: number) => {
      if (!mapa.has(rodadaId)) mapa.set(rodadaId, { ...SITUACAO_VAZIA });
      return mapa.get(rodadaId)!;
    };
    for (const p of participacoes) {
      const s = obter(p.rodadaId);
      s.participando = true;
      s.bilhetes = p.bilhetes;
    }
    for (const g of ganhadores) {
      if (g.situacao === 'CANCELADO' || g.rodadaId === null) continue;
      const s = obter(g.rodadaId);
      s.ganhou = true;
      s.ganhadorId = g.id;
    }
    for (const l of lembretes) obter(l.rodadaId).lembrete = true;
    return mapa;
  }
}

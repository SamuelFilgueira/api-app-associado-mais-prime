import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SorteCampanha, SorteCarteira } from '@prisma/client';
import {
  SorteLancamentoTipo,
  SorteRaspadaResultado,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import {
  dateParaDia,
  diaSaoPaulo,
} from 'src/associado-sorte/helpers/sorte-data.helper';
import { erro409, erro503 } from 'src/associado-sorte/helpers/sorte-erros';
import { calcularJanelaRaspada } from 'src/associado-sorte/helpers/sorte-raspadinha.helper';
import {
  calcularSequencia,
  proximoMarco,
  sequenciaVigente,
} from 'src/associado-sorte/helpers/sorte.helpers';
import { PaginacaoQuery } from 'src/associado-sorte/dto/paginacao.query';
import { metaPaginacao } from 'src/associado-sorte/helpers/sorte.helpers';
import {
  SorteConfigView,
  toRaspadaView,
} from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteRaspadasRepository } from 'src/associado-sorte/repositories/sorte-raspadas.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteRateLimitService } from 'src/associado-sorte/services/sorte-rate-limit.service';
import { SorteTentativaService } from 'src/associado-sorte/services/sorte-tentativa.service';
import { baseTag } from 'src/shared/log.util';

const DIA_MS = 24 * 60 * 60 * 1000;
const ERROS_DE_CONTENCAO = ['P2028', 'P2034'];

export interface RaspadaResultado {
  serverNow: Date;
  raspadaId: number;
  resultado: SorteRaspadaResultado;
  /** Créditos do voucher (0 quando não ganhou). */
  creditos: number;
  /** Bônus da jornada creditado nesta raspada (0 sem marco). */
  bonusJornada: number;
  saldo: number;
  raspadasRestantesHoje: number;
  proximaRaspadaEm: Date;
  voucher: { momentoId: number; descricao: string | null } | null;
  jornada: JornadaView | null;
}

export interface JornadaView {
  sequencia: number;
  proximoMarco: { dias: number; bonus: number; faltam: number } | null;
  marcos: { dias: number; bonus: number }[];
}

/**
 * Raspadinha (seção 2.2), substitui o crédito diário por faixas. O
 * resultado é decidido no servidor antes de o app animar a raspagem.
 *
 * Transação (READ COMMITTED): trava a CARTEIRA (limite diário e intervalo
 * são do associado) e só então reserva o MOMENTO com `FOR UPDATE SKIP
 * LOCKED`. Como o momento nunca espera trava, não há ciclo de espera com a
 * carteira; e o momento não fica preso enquanto a carteira espera.
 */
@Injectable()
export class SorteRaspadinhaService {
  private readonly logger = new Logger(SorteRaspadinhaService.name);

  constructor(
    private readonly rateLimit: SorteRateLimitService,
    private readonly acesso: SorteAcessoService,
    private readonly campanhas: SorteCampanhaService,
    private readonly creditosRepository: SorteCreditosRepository,
    private readonly raspadasRepository: SorteRaspadasRepository,
    private readonly uow: SorteUnidadeTrabalho,
    private readonly creditos: SorteCreditosService,
    private readonly tentativas: SorteTentativaService,
  ) {}

  async raspar(params: {
    userId: number;
    baseOrigin: string;
    agora?: Date;
  }): Promise<RaspadaResultado> {
    const { userId, baseOrigin } = params;
    let campanhaId: number | undefined;
    try {
      await this.rateLimit.verificar('raspar', userId);
      const { config } = await this.acesso.validar(userId, baseOrigin, {
        registrarTentativa: false,
      });
      const agora = params.agora ?? new Date();
      const campanha = await this.exigirCampanhaNoPeriodo(baseOrigin, agora);
      campanhaId = campanha.id;
      await this.creditosRepository.garantirCarteira(userId, baseOrigin);
      return await this.rasparNaTransacao({
        userId,
        baseOrigin,
        config,
        campanha,
        agora,
      });
    } catch (erro) {
      this.tentativas.registrarErro({
        userId,
        baseOrigin,
        acao: 'RASPAR',
        erro,
        contexto: { campanhaId },
      });
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        ERROS_DE_CONTENCAO.includes(erro.code)
      ) {
        throw erro503('Muita gente raspando ao mesmo tempo. Tente de novo.');
      }
      throw erro;
    }
  }

  /** 409 `SEM_CAMPANHA` / `CAMPANHA_FORA_DO_PERIODO`. */
  async exigirCampanhaNoPeriodo(
    baseOrigin: string,
    agora: Date,
  ): Promise<SorteCampanha> {
    const campanha = await this.campanhas.publicadaDaBase(baseOrigin);
    if (!campanha) {
      throw erro409(
        'SEM_CAMPANHA',
        'Não há campanha da raspadinha no ar agora',
      );
    }
    if (
      agora.getTime() < campanha.inicio.getTime() ||
      agora.getTime() >= campanha.fim.getTime()
    ) {
      throw erro409(
        'CAMPANHA_FORA_DO_PERIODO',
        agora.getTime() < campanha.inicio.getTime()
          ? 'A campanha ainda não começou'
          : 'A campanha já terminou',
        { inicio: campanha.inicio, fim: campanha.fim, serverNow: agora },
      );
    }
    return campanha;
  }

  private async rasparNaTransacao(params: {
    userId: number;
    baseOrigin: string;
    config: SorteConfigView;
    campanha: SorteCampanha;
    agora: Date;
  }): Promise<RaspadaResultado> {
    const { userId, baseOrigin, config, campanha, agora } = params;
    const hoje = diaSaoPaulo(agora);

    const r = await this.uow.executar(async (tx) => {
      // 1. Carteira travada: serializa as raspadas do mesmo associado.
      const carteira = await tx.travarCarteira(userId);
      if (!carteira) throw new NotFoundException('Carteira não encontrada');

      // 2. Limite diário e intervalo.
      const doDia = await tx.raspadasDoDia(userId, hoje);
      const janela = calcularJanelaRaspada({
        agora,
        raspadasHoje: doDia.total,
        ultimaRaspadaHojeEm: doDia.ultimaEm,
        raspadasPorDia: config.raspadasPorDia,
        intervaloMinimoMinutos: config.intervaloMinimoMinutos,
      });
      if (
        janela.bloqueio === 'LIMITE_DIARIO' ||
        janela.bloqueio === 'INTERVALO'
      ) {
        // Campo aditivo: quem raspou e perdeu a resposta (rede caiu) recebe
        // aqui o que ganhou, em vez de só o aviso de que já raspou.
        const ultima = await tx.ultimaRaspadaDoDia(userId, hoje);
        const extra = {
          proximaRaspadaEm: janela.proximaRaspadaEm,
          serverNow: agora,
          ultimaRaspada: ultima
            ? {
                raspadaId: ultima.id,
                resultado: ultima.resultado,
                creditos: ultima.creditos,
                bonusJornada: ultima.bonus,
                momentoId: ultima.momentoId,
                em: ultima.createdAt,
              }
            : null,
        };
        throw janela.bloqueio === 'LIMITE_DIARIO'
          ? erro409(
              'LIMITE_DIARIO',
              'Você já usou todas as raspadas de hoje',
              extra,
            )
          : erro409(
              'INTERVALO',
              'Sua próxima raspada ainda não foi liberada',
              extra,
            );
      }

      // 3. Jornada: a primeira raspada do dia conta para a sequência.
      let bonus = 0;
      let sequencia = carteira.sequenciaDias;
      let ultimoDia = carteira.ultimoDiaColetado;
      if (config.jornadaAtiva && doDia.total === 0) {
        const calculo = calcularSequencia({
          hoje,
          ultimoDia: carteira.ultimoDiaColetado,
          sequenciaAnterior: carteira.sequenciaDias,
          marcos: config.marcosSequencia,
        });
        bonus = calculo.bonus;
        sequencia = calculo.sequencia;
        ultimoDia = hoje;
        await tx.atualizarCarteira(carteira.id, {
          sequenciaDias: sequencia,
          ultimoDiaColetado: hoje,
        });
      }

      // 4. Carência: quem ganhou voucher há pouco não olha os momentos.
      const emCarencia =
        config.carenciaDias > 0 &&
        (await tx.ultimoVoucherDesde(
          userId,
          new Date(agora.getTime() - config.carenciaDias * DIA_MS),
        )) !== null;

      // 5. O momento mais antigo já liberado e sem ganhador.
      const momento = emCarencia
        ? null
        : await tx.travarMomentoDisponivel(campanha.id, agora);

      const raspada = await tx.criarRaspada({
        userId,
        baseOrigin,
        campanhaId: campanha.id,
        dia: hoje,
        resultado: momento
          ? SorteRaspadaResultado.GANHOU
          : SorteRaspadaResultado.NAO_GANHOU,
        momentoId: momento?.id ?? null,
        creditos: momento?.creditos ?? 0,
        bonus,
        createdAt: agora,
      });

      if (momento) {
        await tx.marcarMomentoGanho(momento.id, {
          userId,
          ganhoEm: agora,
          raspadaId: raspada.id,
        });
        await this.creditos.lancar(tx, carteira, {
          tipo: SorteLancamentoTipo.VOUCHER_RASPADINHA,
          valor: momento.creditos,
          baseOrigin,
          descricao:
            momento.descricao?.slice(0, 200) ||
            `Voucher de ${momento.creditos} créditos`,
        });
      }
      if (bonus > 0) {
        await this.creditos.lancar(tx, carteira, {
          tipo: SorteLancamentoTipo.BONUS_SEQUENCIA,
          valor: bonus,
          baseOrigin,
          descricao: `Bônus de ${sequencia} dias seguidos`,
        });
      }

      return {
        raspadaId: raspada.id,
        momento,
        bonus,
        saldo: carteira.saldo,
        sequencia,
        ultimoDia,
        raspadasHoje: doDia.total + 1,
      };
    });

    if (r.momento) {
      this.logger.log(
        `${baseTag(baseOrigin)} associado #${userId} ganhou o voucher do momento #${r.momento.id} (${r.momento.creditos} créditos) na raspada #${r.raspadaId}`,
      );
    }

    const depois = calcularJanelaRaspada({
      agora,
      raspadasHoje: r.raspadasHoje,
      ultimaRaspadaHojeEm: agora,
      raspadasPorDia: config.raspadasPorDia,
      intervaloMinimoMinutos: config.intervaloMinimoMinutos,
    });
    return {
      serverNow: new Date(),
      raspadaId: r.raspadaId,
      resultado: r.momento
        ? SorteRaspadaResultado.GANHOU
        : SorteRaspadaResultado.NAO_GANHOU,
      creditos: r.momento?.creditos ?? 0,
      bonusJornada: r.bonus,
      saldo: r.saldo,
      raspadasRestantesHoje: depois.raspadasRestantesHoje,
      proximaRaspadaEm: depois.proximaRaspadaEm,
      voucher: r.momento
        ? { momentoId: r.momento.id, descricao: r.momento.descricao }
        : null,
      jornada: config.jornadaAtiva
        ? jornadaView({
            hoje,
            ultimoDia: r.ultimoDia,
            sequencia: r.sequencia,
            marcos: config.marcosSequencia,
          })
        : null,
    };
  }

  /** Histórico de raspadas do associado (painel). */
  async historicoDoAssociado(userId: number, query: PaginacaoQuery) {
    const { data, total } = await this.raspadasRepository.listarDoAssociado({
      userId,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map(toRaspadaView),
      meta: metaPaginacao(query.page, query.limit, total),
    };
  }

  /** Estado da raspadinha para o `resumo` do app. */
  async estado(params: {
    userId: number;
    config: SorteConfigView;
    carteira: SorteCarteira | null;
    agora: Date;
  }) {
    const { userId, config, carteira, agora } = params;
    const hoje = diaSaoPaulo(agora);
    const doDia = await this.raspadasRepository.estadoDoDia(userId, hoje);
    const janela = calcularJanelaRaspada({
      agora,
      raspadasHoje: doDia.total,
      ultimaRaspadaHojeEm: doDia.ultimaEm,
      raspadasPorDia: config.raspadasPorDia,
      intervaloMinimoMinutos: config.intervaloMinimoMinutos,
    });
    return {
      raspadinha: {
        raspadasPorDia: config.raspadasPorDia,
        intervaloMinimoMinutos: config.intervaloMinimoMinutos,
        raspadasHoje: doDia.total,
        raspadasRestantesHoje: janela.raspadasRestantesHoje,
        proximaRaspadaEm: janela.proximaRaspadaEm,
        /** `null` = pode raspar agora (se houver campanha no período). */
        bloqueio: janela.bloqueio,
      },
      jornada: config.jornadaAtiva
        ? jornadaView({
            hoje,
            ultimoDia: dateParaDia(carteira?.ultimoDiaColetado),
            sequencia: carteira?.sequenciaDias ?? 0,
            marcos: config.marcosSequencia,
          })
        : null,
    };
  }
}

function jornadaView(params: {
  hoje: string;
  ultimoDia: string | null;
  sequencia: number;
  marcos: { dias: number; bonus: number }[];
}): JornadaView {
  return {
    sequencia: sequenciaVigente(params),
    proximoMarco: proximoMarco(params),
    marcos: params.marcos,
  };
}

import { Injectable } from '@nestjs/common';
import {
  Prisma,
  SorteCampanhaEstado,
  SorteColetaDiaria,
  SorteCreditoLancamento,
  SorteEstoqueMovimentoTipo,
  SorteFonteCredito,
  SorteGanhador,
  SorteGanhadorOrigem,
  SorteGanhadorSituacao,
  SorteMecanica,
  SorteModoCredito,
  SorteNotificacaoAdmin,
  SorteNotificacaoAdminTipo,
  SorteParticipacao,
  SorteProdutoTipo,
  SorteRaspada,
  SorteRaspadaResultado,
  SorteRodadaEstado,
} from '@prisma/client';
import { associadoSorteConfig } from 'src/associado-sorte/config/associado-sorte.config';
import {
  dateParaDia,
  diaParaDate,
} from 'src/associado-sorte/helpers/sorte-data.helper';
import { PrismaService } from 'src/database/prisma.service';

/** Linha de `SorteRodada` lida com `FOR UPDATE` (valor mais recente commitado). */
export interface RodadaTravada {
  id: number;
  premioId: number;
  titulo: string | null;
  mecanica: SorteMecanica;
  quantidade: number;
  quantidadeRestante: number;
  custoCreditos: number;
  modoCredito: SorteModoCredito;
  bilhetesMaximos: number;
  abertura: Date;
  encerramento: Date;
  estado: SorteRodadaEstado;
}

export interface PremioTravado {
  id: number;
  nome: string;
  estoque: number;
  ativo: boolean;
  excluido: boolean;
  tipo: SorteProdutoTipo;
  custoCreditos: number;
  naLoja: boolean;
  limitePorAssociado: number;
}

/** Linha de `SorteCampanha` lida com `FOR UPDATE`. */
export interface CampanhaTravada {
  id: number;
  baseOrigin: string;
  nome: string;
  inicio: Date;
  fim: Date;
  estado: SorteCampanhaEstado;
  hashCronograma: string | null;
}

/** Momento premiado reservado pela transação (`FOR UPDATE SKIP LOCKED`). */
export interface MomentoTravado {
  id: number;
  campanhaId: number;
  liberaEm: Date;
  creditos: number;
  descricao: string | null;
}

export interface MomentoDoCronograma {
  id: number;
  liberaEm: Date;
  creditos: number;
  descricao: string | null;
  userId: number | null;
}

export interface CarteiraTravada {
  id: number;
  userId: number;
  baseOrigin: string;
  saldo: number;
  totalGanho: number;
  sequenciaDias: number;
  /** "yyyy-mm-dd" ou null */
  ultimoDiaColetado: string | null;
}

export interface ParticipacaoComUsuario extends SorteParticipacao {
  user: { id: number; name: string; isActive: boolean };
}

/**
 * Operações de dados dentro de UMA transação do Associado da Sorte.
 *
 * Regras de uso (seção 5.2 da spec):
 *  - travar sempre na ordem rodada → prêmio → carteira;
 *  - as leituras `travar*` usam `SELECT ... FOR UPDATE` e devolvem o valor
 *    mais recente commitado; decisões de estoque/saldo usam só esses valores;
 *  - nada de chamada externa (push, upload, HTTP) aqui dentro.
 *
 * A classe só acessa dados; as regras ficam nos services, que recebem um
 * `SorteTx` e por isso são testáveis com um dublê simples.
 */
export class SorteTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  // ----------------------------------------------------------------- travas

  async travarRodada(id: number): Promise<RodadaTravada | null> {
    const linhas = await this.tx.$queryRaw<RodadaTravada[]>`
      SELECT id, premioId, titulo, mecanica, quantidade, quantidadeRestante,
             custoCreditos, modoCredito, bilhetesMaximos, abertura,
             encerramento, estado
      FROM SorteRodada WHERE id = ${id} FOR UPDATE`;
    const r = linhas[0];
    if (!r) return null;
    return {
      ...r,
      id: Number(r.id),
      premioId: Number(r.premioId),
      quantidade: Number(r.quantidade),
      quantidadeRestante: Number(r.quantidadeRestante),
      custoCreditos: Number(r.custoCreditos),
      bilhetesMaximos: Number(r.bilhetesMaximos),
      abertura: new Date(r.abertura),
      encerramento: new Date(r.encerramento),
    };
  }

  async travarPremio(id: number): Promise<PremioTravado | null> {
    const linhas = await this.tx.$queryRaw<
      {
        id: number;
        nome: string;
        estoque: number;
        ativo: number | boolean;
        deletedAt: Date | null;
        tipo: SorteProdutoTipo;
        custoCreditos: number;
        naLoja: number | boolean;
        limitePorAssociado: number;
      }[]
    >`SELECT id, nome, estoque, ativo, deletedAt, tipo, custoCreditos, naLoja,
             limitePorAssociado
      FROM SortePremio WHERE id = ${id} FOR UPDATE`;
    const p = linhas[0];
    if (!p) return null;
    return {
      id: Number(p.id),
      nome: p.nome,
      estoque: Number(p.estoque),
      ativo: Boolean(Number(p.ativo)),
      excluido: p.deletedAt !== null,
      tipo: p.tipo,
      custoCreditos: Number(p.custoCreditos),
      naLoja: Boolean(Number(p.naLoja)),
      limitePorAssociado: Number(p.limitePorAssociado),
    };
  }

  /** A carteira precisa existir (`SorteCreditosRepository.garantirCarteira`). */
  async travarCarteira(userId: number): Promise<CarteiraTravada | null> {
    const linhas = await this.tx.$queryRaw<
      {
        id: number;
        userId: number;
        baseOrigin: string;
        saldo: number;
        totalGanho: number;
        sequenciaDias: number;
        ultimoDiaColetado: Date | string | null;
      }[]
    >`SELECT id, userId, baseOrigin, saldo, totalGanho, sequenciaDias,
             ultimoDiaColetado
      FROM SorteCarteira WHERE userId = ${userId} FOR UPDATE`;
    const c = linhas[0];
    if (!c) return null;
    return {
      id: Number(c.id),
      userId: Number(c.userId),
      baseOrigin: c.baseOrigin,
      saldo: Number(c.saldo),
      totalGanho: Number(c.totalGanho),
      sequenciaDias: Number(c.sequenciaDias),
      ultimoDiaColetado: dateParaDia(c.ultimoDiaColetado),
    };
  }

  /** Trava as carteiras em ordem crescente de `userId` (evita deadlock). */
  async travarCarteiras(
    userIds: number[],
  ): Promise<Map<number, CarteiraTravada>> {
    const mapa = new Map<number, CarteiraTravada>();
    const ordenados = [...new Set(userIds)].sort((a, b) => a - b);
    for (const userId of ordenados) {
      const carteira = await this.travarCarteira(userId);
      if (carteira) mapa.set(userId, carteira);
    }
    return mapa;
  }

  // ---------------------------------------------------------------- créditos

  async atualizarCarteira(
    id: number,
    data: {
      saldo?: number;
      totalGanho?: number;
      sequenciaDias?: number;
      ultimoDiaColetado?: string;
      lembreteRaspadaEm?: Date;
    },
  ): Promise<void> {
    await this.tx.sorteCarteira.update({
      where: { id },
      data: {
        saldo: data.saldo,
        totalGanho: data.totalGanho,
        sequenciaDias: data.sequenciaDias,
        lembreteRaspadaEm: data.lembreteRaspadaEm,
        ultimoDiaColetado: data.ultimoDiaColetado
          ? diaParaDate(data.ultimoDiaColetado)
          : undefined,
      },
    });
  }

  criarLancamento(data: {
    userId: number;
    baseOrigin: string;
    tipo: string;
    valor: number;
    saldoApos: number;
    rodadaId?: number | null;
    descricao?: string | null;
    autorId?: number | null;
    autorNome?: string | null;
  }): Promise<SorteCreditoLancamento> {
    return this.tx.sorteCreditoLancamento.create({ data });
  }

  // ------------------------------------------------------------ coleta diária

  buscarColeta(userId: number, dia: string): Promise<SorteColetaDiaria | null> {
    return this.tx.sorteColetaDiaria.findUnique({
      where: { userId_dia: { userId, dia: diaParaDate(dia) } },
    });
  }

  criarColeta(data: {
    userId: number;
    baseOrigin: string;
    dia: string;
    fonte: SorteFonteCredito;
    creditos: number;
    bonus: number;
    sequencia: number;
  }): Promise<SorteColetaDiaria> {
    return this.tx.sorteColetaDiaria.create({
      data: { ...data, dia: diaParaDate(data.dia) },
    });
  }

  // ------------------------------------------------------------------ rodada

  async atualizarRodada(
    id: number,
    data: Prisma.SorteRodadaUncheckedUpdateInput,
  ): Promise<void> {
    await this.tx.sorteRodada.update({ where: { id }, data });
  }

  async substituirBases(
    rodadaId: number,
    baseOrigins: string[],
  ): Promise<void> {
    await this.tx.sorteRodadaBase.deleteMany({ where: { rodadaId } });
    await this.tx.sorteRodadaBase.createMany({
      data: baseOrigins.map((baseOrigin) => ({ rodadaId, baseOrigin })),
    });
  }

  async contarBases(rodadaId: number): Promise<number> {
    return this.tx.sorteRodadaBase.count({ where: { rodadaId } });
  }

  /**
   * Unidades ainda comprometidas em OUTRAS rodadas publicadas do mesmo prêmio
   * (validação de estoque ao publicar). Chamar com o prêmio travado.
   */
  async somarReservadoEmOutrasRodadas(
    premioId: number,
    rodadaId: number,
  ): Promise<number> {
    const soma = await this.tx.sorteRodada.aggregate({
      where: {
        premioId,
        id: { not: rodadaId },
        estado: {
          in: [SorteRodadaEstado.PUBLICADA, SorteRodadaEstado.APURANDO],
        },
      },
      _sum: { quantidadeRestante: true },
    });
    return soma._sum.quantidadeRestante ?? 0;
  }

  // ----------------------------------------------------------------- estoque

  async atualizarEstoque(premioId: number, estoque: number): Promise<void> {
    await this.tx.sortePremio.update({
      where: { id: premioId },
      data: { estoque },
    });
  }

  async criarMovimentoEstoque(data: {
    premioId: number;
    tipo: SorteEstoqueMovimentoTipo;
    quantidade: number;
    estoqueApos: number;
    motivo?: string | null;
    rodadaId?: number | null;
    ganhadorId?: number | null;
    autorId?: number | null;
    autorNome?: string | null;
  }): Promise<void> {
    await this.tx.sorteEstoqueMovimento.create({ data });
  }

  // ------------------------------------------------------------ participação

  buscarParticipacao(
    rodadaId: number,
    userId: number,
  ): Promise<SorteParticipacao | null> {
    return this.tx.sorteParticipacao.findUnique({
      where: { rodadaId_userId: { rodadaId, userId } },
    });
  }

  criarParticipacao(data: {
    rodadaId: number;
    userId: number;
    baseOrigin: string;
    bilhetes: number;
    creditosGastos: number;
  }): Promise<SorteParticipacao> {
    return this.tx.sorteParticipacao.create({ data });
  }

  listarParticipacoes(rodadaId: number): Promise<ParticipacaoComUsuario[]> {
    return this.tx.sorteParticipacao.findMany({
      where: { rodadaId },
      orderBy: { id: 'asc' },
      include: { user: { select: { id: true, name: true, isActive: true } } },
    });
  }

  async marcarParticipacoesEstornadas(
    rodadaId: number,
    quando: Date,
  ): Promise<void> {
    await this.tx.sorteParticipacao.updateMany({
      where: { rodadaId, estornadoEm: null },
      data: { estornadoEm: quando },
    });
  }

  // ---------------------------------------------------------------- ganhador

  /**
   * Unicidade da corrida/vitrine (uma unidade por associado por rodada):
   * garantida aqui, com a rodada e a carteira travadas, desde que o índice
   * único `(rodadaId, userId)` saiu para a compra da loja (v2).
   */
  buscarGanhadorDaRodada(
    rodadaId: number,
    userId: number,
  ): Promise<SorteGanhador | null> {
    return this.tx.sorteGanhador.findFirst({ where: { rodadaId, userId } });
  }

  buscarGanhador(id: number): Promise<SorteGanhador | null> {
    return this.tx.sorteGanhador.findUnique({ where: { id } });
  }

  /**
   * Usuários em carência: ganharam (SORTEIO ou CORRIDA, não cancelado) depois
   * de `desde`. Vitrine (RESGATE) é troca direta e não gera carência.
   */
  async usuariosEmCarencia(userIds: number[], desde: Date): Promise<number[]> {
    if (userIds.length === 0) return [];
    const linhas = await this.tx.sorteGanhador.findMany({
      where: {
        userId: { in: userIds },
        origem: { in: [SorteMecanica.SORTEIO, SorteMecanica.CORRIDA] },
        situacao: { not: SorteGanhadorSituacao.CANCELADO },
        createdAt: { gt: desde },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return linhas.map((l) => l.userId);
  }

  async existeCodigo(codigo: string): Promise<boolean> {
    const total = await this.tx.sorteGanhador.count({ where: { codigo } });
    return total > 0;
  }

  criarGanhador(data: {
    rodadaId: number | null;
    premioId: number;
    userId: number;
    baseOrigin: string;
    codigo: string;
    origem: SorteGanhadorOrigem;
    creditosGastos: number;
  }): Promise<SorteGanhador> {
    return this.tx.sorteGanhador.create({ data });
  }

  /** Compras do associado neste produto da loja (não canceladas). */
  contarComprasDoProduto(premioId: number, userId: number): Promise<number> {
    return this.tx.sorteGanhador.count({
      where: {
        premioId,
        userId,
        origem: SorteGanhadorOrigem.LOJA,
        situacao: { not: SorteGanhadorSituacao.CANCELADO },
      },
    });
  }

  // ---------------------------------------------------------------- campanha

  async travarCampanha(id: number): Promise<CampanhaTravada | null> {
    const linhas = await this.tx.$queryRaw<CampanhaTravada[]>`
      SELECT id, baseOrigin, nome, inicio, fim, estado, hashCronograma
      FROM SorteCampanha WHERE id = ${id} FOR UPDATE`;
    const c = linhas[0];
    if (!c) return null;
    return {
      ...c,
      id: Number(c.id),
      inicio: new Date(c.inicio),
      fim: new Date(c.fim),
    };
  }

  async atualizarCampanha(
    id: number,
    data: Prisma.SorteCampanhaUncheckedUpdateInput,
  ): Promise<void> {
    await this.tx.sorteCampanha.update({ where: { id }, data });
  }

  contarCampanhasPublicadas(
    baseOrigin: string,
    excetoId: number,
  ): Promise<number> {
    return this.tx.sorteCampanha.count({
      where: {
        baseOrigin,
        estado: SorteCampanhaEstado.PUBLICADA,
        id: { not: excetoId },
      },
    });
  }

  listarMomentos(campanhaId: number): Promise<MomentoDoCronograma[]> {
    return this.tx.sorteMomentoPremiado.findMany({
      where: { campanhaId },
      orderBy: [{ liberaEm: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        liberaEm: true,
        creditos: true,
        descricao: true,
        userId: true,
      },
    });
  }

  async criarMomentos(
    campanhaId: number,
    momentos: { liberaEm: Date; creditos: number; descricao: string | null }[],
  ): Promise<number> {
    if (momentos.length === 0) return 0;
    const r = await this.tx.sorteMomentoPremiado.createMany({
      data: momentos.map((m) => ({ ...m, campanhaId })),
    });
    return r.count;
  }

  async removerMomentos(campanhaId: number, ids?: number[]): Promise<number> {
    const r = await this.tx.sorteMomentoPremiado.deleteMany({
      where: { campanhaId, ...(ids ? { id: { in: ids } } : {}) },
    });
    return r.count;
  }

  async atualizarMomento(
    id: number,
    data: { liberaEm?: Date; creditos?: number; descricao?: string | null },
  ): Promise<void> {
    await this.tx.sorteMomentoPremiado.update({ where: { id }, data });
  }

  // -------------------------------------------------------------- raspadinha

  /** Raspadas do associado no dia (São Paulo): quantidade e a última. */
  async raspadasDoDia(
    userId: number,
    dia: string,
  ): Promise<{ total: number; ultimaEm: Date | null }> {
    const r = await this.tx.sorteRaspada.aggregate({
      where: { userId, dia: diaParaDate(dia) },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return { total: r._count._all, ultimaEm: r._max.createdAt ?? null };
  }

  /** Último voucher ganho depois de `desde` (carência), ou `null`. */
  async ultimoVoucherDesde(userId: number, desde: Date): Promise<Date | null> {
    const r = await this.tx.sorteRaspada.findFirst({
      where: {
        userId,
        resultado: SorteRaspadaResultado.GANHOU,
        createdAt: { gt: desde },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return r?.createdAt ?? null;
  }

  /**
   * O momento mais antigo já liberado e ainda sem ganhador da campanha
   * publicada. `SKIP LOCKED` (MariaDB ≥ 10.6): quem raspa ao mesmo tempo pula
   * o momento que outra transação já reservou, em vez de esperar por ele.
   */
  async travarMomentoDisponivel(
    campanhaId: number,
    agora: Date,
  ): Promise<MomentoTravado | null> {
    const linhas = await this.tx.$queryRaw<MomentoTravado[]>`
      SELECT m.id, m.campanhaId, m.liberaEm, m.creditos, m.descricao
      FROM SorteMomentoPremiado m
      WHERE m.campanhaId = ${campanhaId}
        AND m.userId IS NULL
        AND m.liberaEm <= ${agora}
      ORDER BY m.liberaEm ASC, m.id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const m = linhas[0];
    if (!m) return null;
    return {
      id: Number(m.id),
      campanhaId: Number(m.campanhaId),
      liberaEm: new Date(m.liberaEm),
      creditos: Number(m.creditos),
      descricao: m.descricao,
    };
  }

  criarRaspada(data: {
    userId: number;
    baseOrigin: string;
    campanhaId: number;
    dia: string;
    resultado: SorteRaspadaResultado;
    momentoId: number | null;
    creditos: number;
    bonus: number;
    createdAt: Date;
  }): Promise<SorteRaspada> {
    return this.tx.sorteRaspada.create({
      data: { ...data, dia: diaParaDate(data.dia) },
    });
  }

  async marcarMomentoGanho(
    id: number,
    data: { userId: number; ganhoEm: Date; raspadaId: number },
  ): Promise<void> {
    await this.tx.sorteMomentoPremiado.update({ where: { id }, data });
  }

  // ------------------------------------------------------ notificação painel

  criarNotificacaoAdmin(data: {
    baseOrigin: string;
    tipo: SorteNotificacaoAdminTipo;
    titulo: string;
    mensagem: string;
    ganhadorId?: number | null;
    premioId?: number | null;
    emailDestinatarios?: string | null;
  }): Promise<SorteNotificacaoAdmin> {
    return this.tx.sorteNotificacaoAdmin.create({ data });
  }

  atualizarGanhador(
    id: number,
    data: Prisma.SorteGanhadorUncheckedUpdateInput,
  ): Promise<SorteGanhador> {
    return this.tx.sorteGanhador.update({ where: { id }, data });
  }
}

/**
 * Abre a transação interativa do Prisma e entrega um `SorteTx`.
 *
 * Isolamento READ COMMITTED: cada leitura dentro da transação enxerga o que
 * já foi commitado por quem segurava a trava antes (com o REPEATABLE READ
 * padrão do MySQL, uma leitura comum feita depois de esperar uma trava
 * poderia devolver um retrato antigo), e não há gap lock entre associados.
 */
@Injectable()
export class SorteUnidadeTrabalho {
  constructor(private readonly prisma: PrismaService) {}

  executar<T>(
    fn: (tx: SorteTx) => Promise<T>,
    opcoes?: { longa?: boolean },
  ): Promise<T> {
    const config = associadoSorteConfig();
    const limites = opcoes?.longa ? config.transacaoLonga : config.transacao;
    return this.prisma.$transaction((tx) => fn(new SorteTx(tx)), {
      maxWait: limites.maxWait,
      timeout: limites.timeout,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
}

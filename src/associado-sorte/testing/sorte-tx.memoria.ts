/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- dublê de teste: os registros são objetos soltos, conferidos pelos specs */
import { dateParaDia } from 'src/associado-sorte/helpers/sorte-data.helper';
import {
  CampanhaTravada,
  CarteiraTravada,
  PremioTravado,
  RodadaTravada,
  SorteTx,
  SorteUnidadeTrabalho,
} from 'src/associado-sorte/repositories/sorte-transacao';

/**
 * Dublê em memória de `SorteTx` para os specs de serviço: guarda o estado
 * (rodadas, prêmios, carteiras, lançamentos, ganhadores...) e registra a
 * ordem das travas. Não é usado em produção (fora do build).
 */
export class SorteTxMemoria {
  rodadas = new Map<number, RodadaTravada>();
  premios = new Map<number, PremioTravado>();
  carteiras = new Map<number, CarteiraTravada>();
  coletas: any[] = [];
  lancamentos: any[] = [];
  participacoes: any[] = [];
  ganhadores: any[] = [];
  movimentos: any[] = [];
  bases = new Map<number, string[]>();
  campanhas = new Map<number, CampanhaTravada>();
  momentos: any[] = [];
  raspadas: any[] = [];
  notificacoesAdmin: any[] = [];
  /** Usuários que o dublê considera em carência. */
  emCarencia = new Set<number>();
  /** Ordem em que as travas foram pedidas: "rodada:1", "premio:2", "carteira:3". */
  travas: string[] = [];
  private readonly ids = { proximo: 1 };
  /** Fila de espera por linha travada (simula o `FOR UPDATE`). */
  private readonly filaDeTravas = new Map<string, Promise<void>>();
  /** Sessão que segura cada linha agora (para simular o `SKIP LOCKED`). */
  private readonly donos = new Map<string, object>();
  /** Preenchido só dentro de `executar`: travas e retrato da transação. */
  private sessao: {
    liberar: Map<string, () => void>;
    foto: ReturnType<SorteTxMemoria['fotografar']> | null;
  } | null = null;

  // --------------------------------------------------------------- preparo

  comRodada(rodada: Partial<RodadaTravada> & { id: number }): this {
    this.rodadas.set(rodada.id, {
      premioId: 1,
      titulo: null,
      mecanica: 'CORRIDA',
      quantidade: 1,
      quantidadeRestante: rodada.quantidade ?? 1,
      custoCreditos: 0,
      modoCredito: 'CONSOME',
      bilhetesMaximos: 1,
      abertura: new Date(Date.now() - 60_000),
      encerramento: new Date(Date.now() + 3_600_000),
      estado: 'PUBLICADA',
      ...rodada,
    });
    return this;
  }

  comPremio(id: number, estoque: number, extra?: Partial<PremioTravado>) {
    this.premios.set(id, {
      id,
      nome: `Prêmio ${id}`,
      estoque,
      ativo: true,
      excluido: false,
      tipo: 'FISICO',
      custoCreditos: 0,
      naLoja: false,
      limitePorAssociado: 0,
      ...extra,
    });
    return this;
  }

  comCampanha(campanha: Partial<CampanhaTravada> & { id: number }): this {
    this.campanhas.set(campanha.id, {
      baseOrigin: 'MAIS_PRIME',
      nome: `Campanha ${campanha.id}`,
      inicio: new Date('2026-01-01T03:00:00.000Z'),
      fim: new Date('2027-01-01T03:00:00.000Z'),
      estado: 'PUBLICADA',
      hashCronograma: null,
      ...campanha,
    });
    return this;
  }

  comMomento(m: {
    id?: number;
    campanhaId: number;
    liberaEm: Date;
    creditos: number;
    descricao?: string | null;
  }): this {
    this.momentos.push({
      id: m.id ?? this.ids.proximo++,
      descricao: null,
      userId: null,
      ganhoEm: null,
      raspadaId: null,
      ...m,
    });
    return this;
  }

  comRaspada(r: {
    userId: number;
    createdAt: Date;
    dia: string;
    resultado?: 'GANHOU' | 'NAO_GANHOU';
    campanhaId?: number;
  }): this {
    this.raspadas.push({
      id: this.ids.proximo++,
      baseOrigin: 'MAIS_PRIME',
      campanhaId: 1,
      resultado: 'NAO_GANHOU',
      momentoId: null,
      creditos: 0,
      bonus: 0,
      ...r,
    });
    return this;
  }

  comCarteira(userId: number, saldo: number, extra?: Partial<CarteiraTravada>) {
    this.carteiras.set(userId, {
      id: userId * 10,
      userId,
      baseOrigin: 'MAIS_PRIME',
      saldo,
      totalGanho: 0,
      sequenciaDias: 0,
      ultimoDiaColetado: null,
      ...extra,
    });
    return this;
  }

  comParticipacao(p: {
    rodadaId: number;
    userId: number;
    bilhetes: number;
    creditosGastos?: number;
    baseOrigin?: string;
    ativo?: boolean;
  }): this {
    this.participacoes.push({
      id: this.ids.proximo++,
      baseOrigin: 'MAIS_PRIME',
      creditosGastos: 0,
      estornadoEm: null,
      createdAt: new Date(),
      ...p,
      user: {
        id: p.userId,
        name: `Associado ${p.userId}`,
        isActive: p.ativo ?? true,
      },
    });
    return this;
  }

  saldo(userId: number): number {
    return this.carteiras.get(userId)?.saldo ?? 0;
  }

  // ----------------------------------------------------------------- travas

  /**
   * Espera a linha ficar livre e a segura até o fim da transação, como o
   * `SELECT ... FOR UPDATE`. Fora de `executar` não trava nada.
   */
  private async travar(chave: string): Promise<void> {
    this.travas.push(chave);
    const sessao = this.sessao;
    if (!sessao || sessao.liberar.has(chave)) return;

    const anterior = this.filaDeTravas.get(chave) ?? Promise.resolve();
    let liberar!: () => void;
    const minha = new Promise<void>((resolve) => (liberar = resolve));
    this.filaDeTravas.set(
      chave,
      anterior.then(() => minha),
    );
    await anterior;
    this.donos.set(chave, sessao);
    sessao.liberar.set(chave, () => {
      this.donos.delete(chave);
      liberar();
    });
    // O retrato do rollback é tirado com a primeira linha já travada.
    if (!sessao.foto) sessao.foto = this.fotografar();
  }

  async travarRodada(id: number) {
    await this.travar(`rodada:${id}`);
    const r = this.rodadas.get(id);
    return r ? { ...r } : null;
  }

  async travarPremio(id: number) {
    await this.travar(`premio:${id}`);
    const p = this.premios.get(id);
    return p ? { ...p } : null;
  }

  async travarCarteira(userId: number) {
    await this.travar(`carteira:${userId}`);
    const c = this.carteiras.get(userId);
    return c ? { ...c } : null;
  }

  async travarCarteiras(userIds: number[]) {
    const mapa = new Map<number, CarteiraTravada>();
    for (const userId of [...new Set(userIds)].sort((a, b) => a - b)) {
      const c = await this.travarCarteira(userId);
      if (c) mapa.set(userId, c);
    }
    return mapa;
  }

  // ---------------------------------------------------------------- créditos

  atualizarCarteira(id: number, data: Partial<CarteiraTravada>) {
    for (const c of this.carteiras.values()) {
      if (c.id !== id) continue;
      for (const [chave, valor] of Object.entries(data)) {
        if (valor !== undefined) (c as any)[chave] = valor;
      }
    }
    return Promise.resolve();
  }

  criarLancamento(data: any) {
    const l = { id: this.ids.proximo++, ...data };
    this.lancamentos.push(l);
    return Promise.resolve(l);
  }

  // ------------------------------------------------------------ coleta diária

  buscarColeta(userId: number, dia: string) {
    return Promise.resolve(
      this.coletas.find((c) => c.userId === userId && c.dia === dia) ?? null,
    );
  }

  criarColeta(data: any) {
    const c = { id: this.ids.proximo++, createdAt: new Date(), ...data };
    this.coletas.push(c);
    return Promise.resolve(c);
  }

  // ------------------------------------------------------------------ rodada

  atualizarRodada(id: number, data: any) {
    const r = this.rodadas.get(id);
    if (r) Object.assign(r, data);
    return Promise.resolve();
  }

  substituirBases(rodadaId: number, baseOrigins: string[]) {
    this.bases.set(rodadaId, baseOrigins);
    return Promise.resolve();
  }

  contarBases(rodadaId: number) {
    return Promise.resolve(this.bases.get(rodadaId)?.length ?? 1);
  }

  somarReservadoEmOutrasRodadas(premioId: number, rodadaId: number) {
    let soma = 0;
    for (const r of this.rodadas.values()) {
      if (
        r.premioId === premioId &&
        r.id !== rodadaId &&
        (r.estado === 'PUBLICADA' || r.estado === 'APURANDO')
      ) {
        soma += r.quantidadeRestante;
      }
    }
    return Promise.resolve(soma);
  }

  // ----------------------------------------------------------------- estoque

  atualizarEstoque(premioId: number, estoque: number) {
    const p = this.premios.get(premioId);
    if (p) p.estoque = estoque;
    return Promise.resolve();
  }

  criarMovimentoEstoque(data: any) {
    this.movimentos.push({ id: this.ids.proximo++, ...data });
    return Promise.resolve();
  }

  // ------------------------------------------------------------ participação

  buscarParticipacao(rodadaId: number, userId: number) {
    return Promise.resolve(
      this.participacoes.find(
        (p) => p.rodadaId === rodadaId && p.userId === userId,
      ) ?? null,
    );
  }

  criarParticipacao(data: any) {
    const p = {
      id: this.ids.proximo++,
      estornadoEm: null,
      createdAt: new Date(),
      ...data,
      user: {
        id: data.userId,
        name: `Associado ${data.userId}`,
        isActive: true,
      },
    };
    this.participacoes.push(p);
    return Promise.resolve(p);
  }

  listarParticipacoes(rodadaId: number) {
    return Promise.resolve(
      this.participacoes.filter((p) => p.rodadaId === rodadaId),
    );
  }

  marcarParticipacoesEstornadas(rodadaId: number, quando: Date) {
    for (const p of this.participacoes) {
      if (p.rodadaId === rodadaId && !p.estornadoEm) p.estornadoEm = quando;
    }
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- ganhador

  buscarGanhadorDaRodada(rodadaId: number, userId: number) {
    return Promise.resolve(
      this.ganhadores.find(
        (g) => g.rodadaId === rodadaId && g.userId === userId,
      ) ?? null,
    );
  }

  buscarGanhador(id: number) {
    return Promise.resolve(this.ganhadores.find((g) => g.id === id) ?? null);
  }

  usuariosEmCarencia(userIds: number[]) {
    return Promise.resolve(userIds.filter((id) => this.emCarencia.has(id)));
  }

  existeCodigo(codigo: string) {
    return Promise.resolve(this.ganhadores.some((g) => g.codigo === codigo));
  }

  criarGanhador(data: any) {
    const g = {
      id: this.ids.proximo++,
      situacao: 'AGUARDANDO_CONTATO',
      createdAt: new Date(),
      ...data,
    };
    this.ganhadores.push(g);
    return Promise.resolve(g);
  }

  atualizarGanhador(id: number, data: any) {
    const g = this.ganhadores.find((x) => x.id === id);
    if (g) Object.assign(g, data);
    return Promise.resolve(g);
  }

  contarComprasDoProduto(premioId: number, userId: number) {
    return Promise.resolve(
      this.ganhadores.filter(
        (g) =>
          g.premioId === premioId &&
          g.userId === userId &&
          g.origem === 'LOJA' &&
          g.situacao !== 'CANCELADO',
      ).length,
    );
  }

  // ---------------------------------------------------------------- campanha

  async travarCampanha(id: number) {
    await this.travar(`campanha:${id}`);
    const c = this.campanhas.get(id);
    return c ? { ...c } : null;
  }

  atualizarCampanha(id: number, data: any) {
    const c = this.campanhas.get(id);
    if (c) Object.assign(c, data);
    return Promise.resolve();
  }

  contarCampanhasPublicadas(baseOrigin: string, excetoId: number) {
    return Promise.resolve(
      [...this.campanhas.values()].filter(
        (c) =>
          c.baseOrigin === baseOrigin &&
          c.estado === 'PUBLICADA' &&
          c.id !== excetoId,
      ).length,
    );
  }

  listarMomentos(campanhaId: number) {
    return Promise.resolve(
      this.momentos
        .filter((m) => m.campanhaId === campanhaId)
        .sort(
          (a, b) => a.liberaEm.getTime() - b.liberaEm.getTime() || a.id - b.id,
        )
        .map((m) => ({ ...m })),
    );
  }

  criarMomentos(campanhaId: number, momentos: any[]) {
    for (const m of momentos) this.comMomento({ ...m, campanhaId });
    return Promise.resolve(momentos.length);
  }

  removerMomentos(campanhaId: number, ids?: number[]) {
    // Muta no lugar: a "transação" é um Object.create da raiz.
    let removidos = 0;
    for (let i = this.momentos.length - 1; i >= 0; i--) {
      const m = this.momentos[i];
      if (m.campanhaId === campanhaId && (!ids || ids.includes(m.id))) {
        this.momentos.splice(i, 1);
        removidos++;
      }
    }
    return Promise.resolve(removidos);
  }

  atualizarMomento(id: number, data: any) {
    const m = this.momentos.find((x) => x.id === id);
    if (m) Object.assign(m, data);
    return Promise.resolve();
  }

  // -------------------------------------------------------------- raspadinha

  raspadasDoDia(userId: number, dia: string) {
    const doDia = this.raspadas.filter(
      (r) => r.userId === userId && r.dia === dia,
    );
    const ultimaEm = doDia.reduce<Date | null>(
      (maior, r) =>
        !maior || r.createdAt.getTime() > maior.getTime() ? r.createdAt : maior,
      null,
    );
    return Promise.resolve({ total: doDia.length, ultimaEm });
  }

  ultimoVoucherDesde(userId: number, desde: Date) {
    const ganhos = this.raspadas
      .filter(
        (r) =>
          r.userId === userId &&
          r.resultado === 'GANHOU' &&
          r.createdAt.getTime() > desde.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(ganhos[0]?.createdAt ?? null);
  }

  /** `FOR UPDATE SKIP LOCKED`: pula o momento que outra transação segura. */
  travarMomentoDisponivel(campanhaId: number, agora: Date) {
    const candidatos = this.momentos
      .filter(
        (m) =>
          m.campanhaId === campanhaId &&
          m.userId === null &&
          m.liberaEm.getTime() <= agora.getTime(),
      )
      .sort(
        (a, b) => a.liberaEm.getTime() - b.liberaEm.getTime() || a.id - b.id,
      );
    const sessao = this.sessao;
    for (const m of candidatos) {
      const chave = `momento:${m.id}`;
      const dono = this.donos.get(chave);
      if (dono && dono !== sessao) continue;
      this.travas.push(chave);
      if (sessao && !sessao.liberar.has(chave)) {
        this.donos.set(chave, sessao);
        sessao.liberar.set(chave, () => this.donos.delete(chave));
        if (!sessao.foto) sessao.foto = this.fotografar();
      }
      return Promise.resolve({
        id: m.id,
        campanhaId: m.campanhaId,
        liberaEm: m.liberaEm,
        creditos: m.creditos,
        descricao: m.descricao,
      });
    }
    return Promise.resolve(null);
  }

  criarRaspada(data: any) {
    const r = { id: this.ids.proximo++, ...data };
    this.raspadas.push(r);
    return Promise.resolve(r);
  }

  marcarMomentoGanho(id: number, data: any) {
    const m = this.momentos.find((x) => x.id === id);
    if (m) Object.assign(m, data);
    return Promise.resolve();
  }

  // ------------------------------------------------------ notificação painel

  criarNotificacaoAdmin(data: any) {
    const n = {
      id: this.ids.proximo++,
      lidaEm: null,
      createdAt: new Date(),
      ...data,
    };
    this.notificacoesAdmin.push(n);
    return Promise.resolve(n);
  }

  /** Dia de uma raspada ("yyyy-mm-dd"), aceitando `Date` ou string. */
  static dia(valor: Date | string): string {
    return dateParaDia(valor)!;
  }

  // ------------------------------------------------------------- transação

  /** Retrato do estado para simular o rollback. */
  private fotografar() {
    return {
      rodadas: new Map([...this.rodadas].map(([k, v]) => [k, { ...v }])),
      premios: new Map([...this.premios].map(([k, v]) => [k, { ...v }])),
      carteiras: new Map([...this.carteiras].map(([k, v]) => [k, { ...v }])),
      coletas: this.coletas.map((x) => ({ ...x })),
      lancamentos: this.lancamentos.map((x) => ({ ...x })),
      participacoes: this.participacoes.map((x) => ({ ...x })),
      ganhadores: this.ganhadores.map((x) => ({ ...x })),
      movimentos: this.movimentos.map((x) => ({ ...x })),
      campanhas: new Map([...this.campanhas].map(([k, v]) => [k, { ...v }])),
      momentos: this.momentos.map((x) => ({ ...x })),
      raspadas: this.raspadas.map((x) => ({ ...x })),
      notificacoesAdmin: this.notificacoesAdmin.map((x) => ({ ...x })),
    };
  }

  /**
   * `SorteUnidadeTrabalho` de teste: cada chamada é uma "transação" com as
   * próprias travas (soltas no fim) e que desfaz tudo se a função lançar,
   * como o rollback real. O estado é compartilhado entre as transações.
   */
  unidadeDeTrabalho(): SorteUnidadeTrabalho {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const raiz = this;
    const executar = async <T>(fn: (tx: SorteTx) => Promise<T>): Promise<T> => {
      const transacao = Object.create(raiz) as SorteTxMemoria;
      const sessao = {
        liberar: new Map<string, () => void>(),
        foto: null as ReturnType<SorteTxMemoria['fotografar']> | null,
      };
      transacao.sessao = sessao;
      try {
        return await fn(transacao as unknown as SorteTx);
      } catch (erro) {
        if (sessao.foto) Object.assign(raiz, sessao.foto);
        throw erro;
      } finally {
        for (const liberar of sessao.liberar.values()) liberar();
      }
    };
    return { executar } as unknown as SorteUnidadeTrabalho;
  }
}

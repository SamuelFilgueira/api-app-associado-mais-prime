import {
  ContagemDoDisparo,
  DesfechoDoDisparo,
  Destinatario,
  ERRO_DISPARO_EXPIRADO,
  EntregaParaEnvio,
  EntregaRecusada,
  EstadoDaEntrega,
  MAX_TENTATIVAS_DA_ENTREGA,
  PaginaDeEntregas,
  ResultadoDoLote,
  TipoDeDisparo,
  entregaAberta,
} from 'src/notifications/domain/push-disparo';
import {
  DisparoPush,
  NovoDisparo,
  PushDisparoRepository,
} from 'src/notifications/repositories/push-disparo.repository';

export interface EntregaEmMemoria {
  id: number;
  disparoId: number;
  userId: number;
  expoPushToken: string;
  estado: EstadoDaEntrega;
  ticketId: string | null;
  erro: string | null;
  tentativas: number;
  enviadaEm: Date | null;
  reciboEm: Date | null;
}

export interface UsuarioEmMemoria {
  id: number;
  expoPushToken: string | null;
  isActive: boolean;
  acceptsMarketingNotifications: boolean;
}

export interface LogEmMemoria {
  id: number;
  status: string;
  title: string;
  body: string;
  messagePayload: unknown;
  sentCount: number | null;
  skippedCount: number | null;
  errorMessage: string | null;
  processedAt: Date | null;
  updatedAt: Date;
}

export interface NotificacaoEmMemoria {
  userId: number;
  expoPushToken: string;
  title: string;
  body: string;
  data: unknown;
}

const LOG_ABERTO = ['REQUESTED', 'SENDING'];
const ESTADOS_DE_ENVIO: EstadoDaEntrega[] = ['PENDENTE', 'FALHA'];

/**
 * `PushDisparoRepository` em memória para os testes de unidade dos casos de
 * uso. Reproduz as CONDIÇÕES de escrita do repositório real (cada mudança de
 * estado só vale a partir do estado anterior; o resultado de um lote é tudo
 * ou nada). O SQL de verdade é coberto pelos testes de integração.
 */
export class PushDisparoRepositoryEmMemoria
  implements Pick<PushDisparoRepository, keyof PushDisparoRepository>
{
  readonly disparos: DisparoPush[] = [];
  readonly entregas: EntregaEmMemoria[] = [];
  readonly usuarios = new Map<number, UsuarioEmMemoria>();
  readonly logs = new Map<number, LogEmMemoria>();
  readonly notificacoes: NotificacaoEmMemoria[] = [];

  /** As próximas N gravações de resultado falham sem gravar nada. */
  gravacoesQueFalham = 0;
  /** Relógio de `criadoEm`. */
  agora: () => Date = () => new Date();

  private sequenciaDeDisparo = 0;
  private sequenciaDeEntrega = 0;

  // ------------------------------------------------- preparação dos testes

  comUsuarios(
    total: number,
    tokenDe: (id: number) => string | null,
  ): UsuarioEmMemoria[] {
    const criados: UsuarioEmMemoria[] = [];
    for (let id = 1; id <= total; id++) {
      const usuario: UsuarioEmMemoria = {
        id,
        expoPushToken: tokenDe(id),
        isActive: true,
        acceptsMarketingNotifications: true,
      };
      this.usuarios.set(id, usuario);
      criados.push(usuario);
    }
    return criados;
  }

  comLog(log: Partial<LogEmMemoria> & { id: number }): LogEmMemoria {
    const completo: LogEmMemoria = {
      status: 'REQUESTED',
      title: 'Título',
      body: 'Corpo',
      messagePayload: { type: 'marketing' },
      sentCount: null,
      skippedCount: null,
      errorMessage: null,
      processedAt: null,
      updatedAt: this.agora(),
      ...log,
    };
    this.logs.set(completo.id, completo);
    return completo;
  }

  entregasDo(disparoId: number): EntregaEmMemoria[] {
    return this.entregas.filter((e) => e.disparoId === disparoId);
  }

  disparo(id: number): DisparoPush {
    const disparo = this.disparos.find((d) => d.id === id);
    if (!disparo) throw new Error(`disparo #${id} não existe`);
    return disparo;
  }

  // --------------------------------------------------------------- criação

  criarDisparo(novo: NovoDisparo): Promise<DisparoPush> {
    const disparo: DisparoPush = {
      id: ++this.sequenciaDeDisparo,
      tipo: novo.tipo,
      marketingAuditLogId: novo.marketingAuditLogId ?? null,
      titulo: novo.titulo,
      corpo: novo.corpo,
      dados: (novo.dados ?? {}) as DisparoPush['dados'],
      estado: 'CRIADO',
      totalDestinatarios: 0,
      totalEnviadas: 0,
      totalRecusadas: 0,
      totalFalhas: 0,
      batimentoEm: null,
      criadoEm: this.agora(),
      concluidoEm: null,
    };
    this.disparos.push(disparo);
    return Promise.resolve({ ...disparo });
  }

  buscarDisparo(id: number): Promise<DisparoPush | null> {
    const disparo = this.disparos.find((d) => d.id === id);
    return Promise.resolve(disparo ? { ...disparo } : null);
  }

  disparoDoLog(auditId: number): Promise<DisparoPush | null> {
    const disparo = this.disparos.find(
      (d) => d.marketingAuditLogId === auditId,
    );
    return Promise.resolve(disparo ? { ...disparo } : null);
  }

  reivindicarAgendado(auditId: number): Promise<DisparoPush | null> {
    const log = this.logs.get(auditId);
    if (!log || log.status !== 'SCHEDULED') return Promise.resolve(null);
    this.mudarLog(log, { status: 'SENDING' });
    return this.criarDisparo({
      tipo: 'MARKETING',
      titulo: log.title,
      corpo: log.body,
      dados: log.messagePayload ?? { type: 'marketing' },
      marketingAuditLogId: auditId,
    });
  }

  candidatosARepeticao(
    tipo: TipoDeDisparo,
    titulo: string,
    desde: Date,
  ): Promise<DisparoPush[]> {
    return Promise.resolve(
      this.disparos
        .filter(
          (d) =>
            d.tipo === tipo &&
            d.titulo === titulo &&
            (d.estado === 'CRIADO' ||
              d.estado === 'ENVIANDO' ||
              (d.estado === 'CONCLUIDO' && d.criadoEm >= desde)),
        )
        .sort((a, b) => b.id - a.id)
        .map((d) => ({ ...d })),
    );
  }

  usuariosDoDisparo(disparoId: number): Promise<number[]> {
    return Promise.resolve(this.entregasDo(disparoId).map((e) => e.userId));
  }

  paginaDeUsuariosDeMarketing(
    aposUserId: number,
    limite: number,
  ): Promise<Array<{ id: number; expoPushToken: string | null }>> {
    return Promise.resolve(
      [...this.usuarios.values()]
        .filter(
          (u) =>
            u.id > aposUserId &&
            u.isActive &&
            u.acceptsMarketingNotifications &&
            u.expoPushToken !== null,
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, limite)
        .map((u) => ({ id: u.id, expoPushToken: u.expoPushToken })),
    );
  }

  criarEntregas(
    disparoId: number,
    destinatarios: Destinatario[],
  ): Promise<void> {
    for (const destinatario of destinatarios) {
      const existe = this.entregas.some(
        (e) => e.disparoId === disparoId && e.userId === destinatario.userId,
      );
      if (existe) continue;
      this.entregas.push({
        id: ++this.sequenciaDeEntrega,
        disparoId,
        userId: destinatario.userId,
        expoPushToken: destinatario.expoPushToken,
        estado: 'PENDENTE',
        ticketId: null,
        erro: null,
        tentativas: 0,
        enviadaEm: null,
        reciboEm: null,
      });
    }
    return Promise.resolve();
  }

  contarEntregas(disparoId: number): Promise<number> {
    return Promise.resolve(this.entregasDo(disparoId).length);
  }

  iniciarEnvio(
    disparoId: number,
    selecao: { total: number; ignorados: number },
    agora: Date,
  ): Promise<boolean> {
    const disparo = this.disparo(disparoId);
    if (disparo.estado !== 'CRIADO') return Promise.resolve(false);
    disparo.estado = 'ENVIANDO';
    disparo.totalDestinatarios = selecao.total;
    disparo.batimentoEm = agora;
    this.mudarLogAberto(disparo.marketingAuditLogId, {
      skippedCount: selecao.ignorados,
    });
    return Promise.resolve(true);
  }

  falharCriacao(disparoId: number, erro: string, agora: Date) {
    const disparo = this.disparo(disparoId);
    if (disparo.estado !== 'CRIADO') return Promise.resolve(false);
    disparo.estado = 'FALHOU';
    disparo.concluidoEm = agora;
    this.mudarLogAberto(disparo.marketingAuditLogId, {
      status: 'FAILED',
      errorMessage: erro.slice(0, 500),
      processedAt: agora,
    });
    return Promise.resolve(true);
  }

  falharLog(auditId: number, erro: string, agora: Date) {
    return Promise.resolve(
      this.mudarLogAberto(auditId, {
        status: 'FAILED',
        errorMessage: erro.slice(0, 500),
        processedAt: agora,
      }),
    );
  }

  // ----------------------------------------------------------------- envio

  blocoDeEntregas(disparoId: number, aposId: number, limite: number) {
    return Promise.resolve(
      this.entregasDo(disparoId)
        .filter((e) => e.id > aposId)
        .sort((a, b) => a.id - b.id)
        .slice(0, limite)
        .map((e) => ({ id: e.id, estado: e.estado, tentativas: e.tentativas })),
    );
  }

  entregasDaPagina(
    disparoId: number,
    pagina: PaginaDeEntregas,
  ): Promise<EntregaParaEnvio[]> {
    return Promise.resolve(
      this.entregasDo(disparoId)
        .filter(
          (e) =>
            e.id >= pagina.deId && e.id <= pagina.ateId && entregaAberta(e),
        )
        .sort((a, b) => a.id - b.id)
        .map((e) => ({
          id: e.id,
          userId: e.userId,
          expoPushToken: e.expoPushToken,
        })),
    );
  }

  gravarResultadoDoLote(
    disparo: Pick<DisparoPush, 'id' | 'titulo' | 'corpo' | 'dados'>,
    resultado: ResultadoDoLote,
    agora: Date,
  ): Promise<{ enviadas: number; recusadas: number; falhas: number }> {
    // Como a transação do repositório real: ou grava tudo, ou nada.
    if (this.gravacoesQueFalham > 0) {
      this.gravacoesQueFalham--;
      return Promise.reject(new Error('ECONNRESET: banco fora'));
    }

    let enviadas = 0;
    for (const aceita of resultado.aceitas) {
      const entrega = this.entregaEm(aceita.id, ESTADOS_DE_ENVIO);
      if (!entrega) continue;
      entrega.estado = 'ENVIADA';
      entrega.ticketId = aceita.ticketId;
      entrega.erro = null;
      entrega.enviadaEm = agora;
      entrega.tentativas++;
      enviadas++;
      if (this.usuarios.has(aceita.userId)) {
        this.notificacoes.push({
          userId: aceita.userId,
          expoPushToken: aceita.expoPushToken,
          title: disparo.titulo,
          body: disparo.corpo,
          data: disparo.dados,
        });
      }
    }

    let recusadas = 0;
    for (const recusada of resultado.recusadas) {
      const entrega = this.entregaEm(recusada.id, ESTADOS_DE_ENVIO);
      if (!entrega) continue;
      entrega.estado = 'RECUSADA';
      entrega.erro = recusada.erro;
      entrega.tentativas++;
      recusadas++;
    }
    this.apagarTokensMortos(resultado.recusadas);

    let falhas = 0;
    for (const falha of resultado.falhas) {
      const entrega = this.entregaEm(falha.id, ESTADOS_DE_ENVIO);
      if (!entrega) continue;
      entrega.estado = 'FALHA';
      entrega.erro = falha.erro;
      entrega.tentativas++;
      falhas++;
    }

    const gravado = this.disparo(disparo.id);
    if (gravado.estado === 'ENVIANDO') {
      gravado.totalEnviadas += enviadas;
      gravado.totalRecusadas += recusadas;
      gravado.batimentoEm = agora;
    }
    return Promise.resolve({ enviadas, recusadas, falhas });
  }

  temAbertas(disparoId: number): Promise<boolean> {
    return Promise.resolve(this.entregasDo(disparoId).some(entregaAberta));
  }

  /** O dublê não guarda CPF: devolve o id do usuário como texto. */
  cpfsSemEnvio(disparoId: number, maximo: number): Promise<string[]> {
    return Promise.resolve(
      this.entregasDo(disparoId)
        .filter((e) => e.estado === 'RECUSADA' || e.estado === 'FALHA')
        .slice(0, maximo)
        .map((e) => String(e.userId)),
    );
  }

  contarPorEstado(
    disparoId: number,
  ): Promise<Partial<Record<EstadoDaEntrega, number>>> {
    const contagem: Partial<Record<EstadoDaEntrega, number>> = {};
    for (const entrega of this.entregasDo(disparoId)) {
      contagem[entrega.estado] = (contagem[entrega.estado] ?? 0) + 1;
    }
    return Promise.resolve(contagem);
  }

  fechar(
    disparoId: number,
    desfecho: DesfechoDoDisparo,
    contagem: ContagemDoDisparo,
    agora: Date,
  ): Promise<boolean> {
    const disparo = this.disparo(disparoId);
    if (disparo.estado !== 'ENVIANDO') return Promise.resolve(false);
    disparo.estado = desfecho.estado;
    disparo.totalEnviadas = contagem.enviadas;
    disparo.totalRecusadas = contagem.recusadas;
    disparo.totalFalhas = contagem.falhas;
    disparo.concluidoEm = agora;
    disparo.batimentoEm = agora;

    const log = disparo.marketingAuditLogId
      ? this.logs.get(disparo.marketingAuditLogId)
      : undefined;
    this.mudarLogAberto(disparo.marketingAuditLogId, {
      status: desfecho.statusDoLog,
      sentCount: contagem.enviadas,
      skippedCount:
        (log?.skippedCount ?? 0) + (contagem.total - contagem.enviadas),
      errorMessage: desfecho.erro,
      processedAt: agora,
    });
    return Promise.resolve(true);
  }

  expirarAbertas(disparoId: number): Promise<number> {
    let expiradas = 0;
    for (const entrega of this.entregasDo(disparoId)) {
      if (!entregaAberta(entrega)) continue;
      entrega.estado = 'FALHA';
      entrega.erro = ERRO_DISPARO_EXPIRADO;
      entrega.tentativas = MAX_TENTATIVAS_DA_ENTREGA;
      expiradas++;
    }
    return Promise.resolve(expiradas);
  }

  // --------------------------------------------------------------- recibos

  entregasAguardandoRecibo(disparoId: number, aposId: number, limite: number) {
    return Promise.resolve(
      this.entregasDo(disparoId)
        .filter(
          (e) => e.id > aposId && e.estado === 'ENVIADA' && e.ticketId !== null,
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, limite)
        .map((e) => ({
          id: e.id,
          userId: e.userId,
          expoPushToken: e.expoPushToken,
          ticketId: e.ticketId as string,
        })),
    );
  }

  gravarRecibos(
    entregues: number[],
    recusadas: EntregaRecusada[],
    agora: Date,
  ): Promise<{ entregues: number; recusadas: number }> {
    let totalEntregues = 0;
    for (const id of entregues) {
      const entrega = this.entregaEm(id, ['ENVIADA']);
      if (!entrega) continue;
      entrega.estado = 'ENTREGUE';
      entrega.reciboEm = agora;
      totalEntregues++;
    }
    let totalRecusadas = 0;
    for (const recusada of recusadas) {
      const entrega = this.entregaEm(recusada.id, ['ENVIADA']);
      if (!entrega) continue;
      entrega.estado = 'RECUSADA';
      entrega.erro = recusada.erro;
      entrega.reciboEm = agora;
      totalRecusadas++;
    }
    this.apagarTokensMortos(recusadas);
    return Promise.resolve({
      entregues: totalEntregues,
      recusadas: totalRecusadas,
    });
  }

  // ------------------------------------------------------------- varredura

  disparosParados(limite: Date, maximo: number): Promise<DisparoPush[]> {
    return Promise.resolve(
      this.disparos
        .filter(
          (d) =>
            (d.estado === 'CRIADO' || d.estado === 'ENVIANDO') &&
            (d.batimentoEm ? d.batimentoEm < limite : d.criadoEm < limite),
        )
        .slice(0, maximo)
        .map((d) => ({ ...d })),
    );
  }

  reivindicarRetomada(
    lido: Pick<DisparoPush, 'id' | 'estado' | 'batimentoEm'>,
    agora: Date,
  ): Promise<boolean> {
    const disparo = this.disparo(lido.id);
    const mesmoBatimento =
      (disparo.batimentoEm?.getTime() ?? null) ===
      (lido.batimentoEm?.getTime() ?? null);
    if (disparo.estado !== lido.estado || !mesmoBatimento) {
      return Promise.resolve(false);
    }
    disparo.batimentoEm = agora;
    return Promise.resolve(true);
  }

  falharLogsOrfaos(limite: Date, agora: Date): Promise<number> {
    let fechados = 0;
    for (const log of this.logs.values()) {
      const orfao =
        LOG_ABERTO.includes(log.status) &&
        log.updatedAt < limite &&
        !this.disparos.some((d) => d.marketingAuditLogId === log.id);
      if (!orfao) continue;
      this.mudarLog(log, {
        status: 'FAILED',
        errorMessage:
          'Envio interrompido antes de concluir; não foi reenviado para evitar duplicidade.',
        processedAt: agora,
      });
      fechados++;
    }
    return Promise.resolve(fechados);
  }

  inicioDoMaisAntigoAberto(): Promise<Date | null> {
    const abertos = this.disparos
      .filter((d) => d.estado === 'CRIADO' || d.estado === 'ENVIANDO')
      .map((d) => d.criadoEm.getTime());
    return Promise.resolve(
      abertos.length > 0 ? new Date(Math.min(...abertos)) : null,
    );
  }

  // --------------------------------------------------------------- interno

  private entregaEm(
    id: number,
    estados: EstadoDaEntrega[],
  ): EntregaEmMemoria | undefined {
    return this.entregas.find((e) => e.id === id && estados.includes(e.estado));
  }

  private apagarTokensMortos(recusadas: EntregaRecusada[]): void {
    for (const recusada of recusadas) {
      if (!recusada.tokenMorto) continue;
      const usuario = this.usuarios.get(recusada.userId);
      if (usuario?.expoPushToken === recusada.expoPushToken) {
        usuario.expoPushToken = null;
      }
    }
  }

  private mudarLogAberto(
    auditId: number | null | undefined,
    mudanca: Partial<LogEmMemoria>,
  ): boolean {
    const log = auditId ? this.logs.get(auditId) : undefined;
    if (!log || !LOG_ABERTO.includes(log.status)) return false;
    this.mudarLog(log, mudanca);
    return true;
  }

  private mudarLog(log: LogEmMemoria, mudanca: Partial<LogEmMemoria>): void {
    Object.assign(log, mudanca, { updatedAt: this.agora() });
  }

  comoRepositorio(): PushDisparoRepository {
    return this as unknown as PushDisparoRepository;
  }
}

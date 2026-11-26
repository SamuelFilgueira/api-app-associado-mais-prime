import { IdempotenciaService } from 'src/infra/idempotencia/idempotencia.service';
import {
  JOB_PUSH_LOTE,
  LoteJobData,
} from 'src/notifications/domain/push-disparo';
import { MarketingAgendamentoService } from 'src/notifications/services/marketing-agendamento.service';
import { MarketingDisparoService } from 'src/notifications/services/marketing-disparo.service';
import { MarketingNotificationAuditService } from 'src/notifications/services/marketing-notification-audit.service';
import { PushDisparoService } from 'src/notifications/services/push-disparo.service';
import {
  LoteProcessado,
  PushLoteService,
} from 'src/notifications/services/push-lote.service';
import { PushRecibosService } from 'src/notifications/services/push-recibos.service';
import {
  JobFalso,
  ProdutorFalso,
  TravaFalsa,
} from 'src/notifications/testing/filas.falsas';
import { PushDisparoRepositoryEmMemoria } from 'src/notifications/testing/push-disparo.repository.memoria';
import { PushGatewayFalso } from 'src/notifications/testing/push-gateway.falso';
import { PUSH_MASSA_QUEUE } from 'src/queue/filas';

/** Token de push com formato válido, um por usuário. */
export const tokenDe = (id: number): string =>
  `ExponentPushToken[${String(id).padStart(22, '0')}]`;

/**
 * Log do painel em memória: registra o pedido como o serviço real (sem
 * usuário do painel não há registro) e guarda a linha no repositório falso,
 * onde o fechamento do disparo a encontra.
 */
export class AuditoriaFalsa {
  private sequencia = 100;

  constructor(private readonly repo: PushDisparoRepositoryEmMemoria) {}

  createRequestAudit(
    adminUserId: number | undefined,
    payload: { title: string; body: string; data?: unknown },
    opcoes?: { tipo?: string; agendarPara?: Date },
  ): Promise<number | null> {
    if (!adminUserId) return Promise.resolve(null);
    const id = ++this.sequencia;
    this.repo.comLog({
      id,
      status: opcoes?.agendarPara ? 'SCHEDULED' : 'REQUESTED',
      title: payload.title,
      body: payload.body,
      messagePayload: payload.data ?? { type: 'marketing' },
    });
    return Promise.resolve(id);
  }

  markFailure(auditId: number | null, erro: string): Promise<void> {
    const log = auditId ? this.repo.logs.get(auditId) : undefined;
    if (log) Object.assign(log, { status: 'FAILED', errorMessage: erro });
    return Promise.resolve();
  }

  comoServico(): MarketingNotificationAuditService {
    return this as unknown as MarketingNotificationAuditService;
  }
}

/** `Idempotency-Key` em memória: a mesma chave devolve a primeira resposta. */
export class IdempotenciaFalsa {
  private readonly respostas = new Map<string, unknown>();

  async executar<T>(
    pedido: { userId: number; escopo: string; chave?: string | null },
    operacao: () => Promise<T>,
  ): Promise<T> {
    if (!pedido.chave) return operacao();
    const chave = `${pedido.userId}|${pedido.escopo}|${pedido.chave}`;
    if (this.respostas.has(chave)) return this.respostas.get(chave) as T;
    const resposta = await operacao();
    this.respostas.set(chave, resposta);
    return resposta;
  }

  comoServico(): IdempotenciaService {
    return this as unknown as IdempotenciaService;
  }
}

export interface ExecucaoDeLote {
  job: JobFalso<LoteJobData>;
  resultado?: LoteProcessado;
  erro?: unknown;
}

/**
 * Monta os casos de uso do push em massa sobre dublês em memória (banco,
 * provedor, fila e trava). `executarLotes` faz o papel do worker.
 */
export function montarCenarioDePushEmMassa() {
  const repo = new PushDisparoRepositoryEmMemoria();
  const gateway = new PushGatewayFalso();
  const produtor = new ProdutorFalso();
  const trava = new TravaFalsa();
  const auditoria = new AuditoriaFalsa(repo);
  const idempotencia = new IdempotenciaFalsa();
  /** Pedidos de agendamento recebidos (o agendamento tem spec próprio). */
  const agendamentos: unknown[] = [];
  const agendamento = {
    agendar: (dto: unknown) => {
      agendamentos.push(dto);
      return Promise.resolve({ agendado: true, id: agendamentos.length });
    },
  } as unknown as MarketingAgendamentoService;

  const recibos = new PushRecibosService(
    repo.comoRepositorio(),
    gateway,
    produtor.comoProdutor(),
  );
  const lotes = new PushLoteService(
    repo.comoRepositorio(),
    gateway,
    trava.comoTrava(),
    recibos,
  );
  const disparos = new PushDisparoService(
    repo.comoRepositorio(),
    gateway,
    produtor.comoProdutor(),
    lotes,
  );
  const marketing = new MarketingDisparoService(
    auditoria.comoServico(),
    disparos,
    agendamento,
    trava.comoTrava(),
    idempotencia.comoServico(),
  );

  const executados = new Set<string>();

  /** Roda, uma vez, cada job de lote que ainda não rodou. */
  async function executarLotes(): Promise<ExecucaoDeLote[]> {
    const execucoes: ExecucaoDeLote[] = [];
    for (const job of produtor.da<LoteJobData>(
      PUSH_MASSA_QUEUE,
      JOB_PUSH_LOTE,
    )) {
      if (executados.has(job.id)) continue;
      executados.add(job.id);
      try {
        execucoes.push({ job, resultado: await lotes.processar(job.dados) });
      } catch (erro) {
        execucoes.push({ job, erro });
      }
    }
    return execucoes;
  }

  return {
    repo,
    gateway,
    produtor,
    trava,
    auditoria,
    idempotencia,
    agendamentos,
    recibos,
    lotes,
    disparos,
    marketing,
    executarLotes,
    jobsDeLote: () => produtor.da<LoteJobData>(PUSH_MASSA_QUEUE, JOB_PUSH_LOTE),
  };
}

export type CenarioDePushEmMassa = ReturnType<
  typeof montarCenarioDePushEmMassa
>;

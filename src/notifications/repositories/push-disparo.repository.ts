import { Injectable } from '@nestjs/common';
import { Prisma, PushDisparo } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
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
} from 'src/notifications/domain/push-disparo';

export interface NovoDisparo {
  tipo: TipoDeDisparo;
  titulo: string;
  corpo: string;
  dados: unknown;
  marketingAuditLogId?: number | null;
}

export type DisparoPush = PushDisparo;

/** Estados do log do painel em que o disparo ainda não terminou. */
const LOG_ABERTO = ['REQUESTED', 'SENDING'];
/** Linhas por `createMany` de entregas. */
const ENTREGAS_POR_INSERT = 1_000;

/** Entrega que ainda vai ser (re)enviada. */
const ENTREGA_ABERTA: Prisma.PushEntregaWhereInput = {
  OR: [
    { estado: 'PENDENTE' },
    { estado: 'FALHA', tentativas: { lt: MAX_TENTATIVAS_DA_ENTREGA } },
  ],
};
/** Estados de onde uma entrega pode receber o resultado de um envio. */
const ESTADOS_DE_ENVIO = { in: ['PENDENTE', 'FALHA'] };

/**
 * Escrita e leitura do push em massa (`PushDisparo`, `PushEntrega`) e do
 * fechamento do log do painel. Toda mudança de estado é condicionada ao
 * estado anterior e devolve se foi ESTA chamada que mudou.
 */
@Injectable()
export class PushDisparoRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------- criação

  criarDisparo(novo: NovoDisparo): Promise<DisparoPush> {
    return this.prisma.pushDisparo.create({
      data: {
        tipo: novo.tipo,
        titulo: novo.titulo,
        corpo: novo.corpo,
        dados: (novo.dados ?? {}) as Prisma.InputJsonValue,
        marketingAuditLogId: novo.marketingAuditLogId ?? null,
      },
    });
  }

  buscarDisparo(id: number): Promise<DisparoPush | null> {
    return this.prisma.pushDisparo.findUnique({ where: { id } });
  }

  disparoDoLog(auditId: number): Promise<DisparoPush | null> {
    return this.prisma.pushDisparo.findFirst({
      where: { marketingAuditLogId: auditId },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Reivindica o agendamento (`SCHEDULED → SENDING`) e cria o disparo na
   * MESMA transação: um log em `SENDING` sempre tem o seu disparo, e duas
   * execuções do job não criam dois. `null` = não estava mais agendado.
   */
  reivindicarAgendado(auditId: number): Promise<DisparoPush | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.marketingNotificationAuditLog.updateMany({
        where: { id: auditId, status: 'SCHEDULED' },
        data: { status: 'SENDING' },
      });
      if (count !== 1) return null;

      const log = await tx.marketingNotificationAuditLog.findUniqueOrThrow({
        where: { id: auditId },
        select: { title: true, body: true, messagePayload: true },
      });
      return tx.pushDisparo.create({
        data: {
          tipo: 'MARKETING',
          marketingAuditLogId: auditId,
          titulo: log.title,
          corpo: log.body,
          dados: (log.messagePayload ?? {
            type: 'marketing',
          }) as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * Disparos do mesmo tipo e título em andamento, ou concluídos desde
   * `desde`. Disparo que falhou fica de fora: repetir depois de uma falha é
   * um pedido novo.
   */
  candidatosARepeticao(
    tipo: TipoDeDisparo,
    titulo: string,
    desde: Date,
  ): Promise<DisparoPush[]> {
    return this.prisma.pushDisparo.findMany({
      where: {
        tipo,
        titulo,
        OR: [
          { estado: { in: ['CRIADO', 'ENVIANDO'] } },
          { estado: 'CONCLUIDO', criadoEm: { gte: desde } },
        ],
      },
      orderBy: { id: 'desc' },
      take: 20,
    });
  }

  async usuariosDoDisparo(disparoId: number): Promise<number[]> {
    const linhas = await this.prisma.pushEntrega.findMany({
      where: { disparoId },
      select: { userId: true },
    });
    return linhas.map((l) => l.userId);
  }

  /** Página de usuários que aceitam marketing e têm token, por id crescente. */
  paginaDeUsuariosDeMarketing(
    aposUserId: number,
    limite: number,
  ): Promise<Array<{ id: number; expoPushToken: string | null }>> {
    return this.prisma.user.findMany({
      where: {
        id: { gt: aposUserId },
        isActive: true,
        acceptsMarketingNotifications: true,
        expoPushToken: { not: null },
      },
      select: { id: true, expoPushToken: true },
      orderBy: { id: 'asc' },
      take: limite,
    });
  }

  /** Uma entrega por destinatário; repetir a chamada não duplica. */
  async criarEntregas(
    disparoId: number,
    destinatarios: Destinatario[],
  ): Promise<void> {
    for (let i = 0; i < destinatarios.length; i += ENTREGAS_POR_INSERT) {
      await this.prisma.pushEntrega.createMany({
        data: destinatarios.slice(i, i + ENTREGAS_POR_INSERT).map((d) => ({
          disparoId,
          userId: d.userId,
          expoPushToken: d.expoPushToken,
        })),
        skipDuplicates: true,
      });
    }
  }

  contarEntregas(disparoId: number): Promise<number> {
    return this.prisma.pushEntrega.count({ where: { disparoId } });
  }

  /**
   * `CRIADO → ENVIANDO`: as entregas estão completas e os lotes podem ser
   * enfileirados. Grava no log quantos ficaram de fora da seleção.
   */
  iniciarEnvio(
    disparoId: number,
    selecao: { total: number; ignorados: number },
    agora: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.pushDisparo.updateMany({
        where: { id: disparoId, estado: 'CRIADO' },
        data: {
          estado: 'ENVIANDO',
          totalDestinatarios: selecao.total,
          batimentoEm: agora,
        },
      });
      if (count !== 1) return false;

      const disparo = await tx.pushDisparo.findUniqueOrThrow({
        where: { id: disparoId },
        select: { marketingAuditLogId: true },
      });
      if (disparo.marketingAuditLogId) {
        await tx.marketingNotificationAuditLog.updateMany({
          where: {
            id: disparo.marketingAuditLogId,
            status: { in: LOG_ABERTO },
          },
          data: { skippedCount: selecao.ignorados },
        });
      }
      return true;
    });
  }

  /**
   * `CRIADO → FALHOU`: a criação não terminou e nenhum lote foi enfileirado
   * (isso só acontece depois de `ENVIANDO`). Fecha o log junto.
   */
  falharCriacao(disparoId: number, erro: string, agora: Date) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.pushDisparo.updateMany({
        where: { id: disparoId, estado: 'CRIADO' },
        data: { estado: 'FALHOU', concluidoEm: agora },
      });
      if (count !== 1) return false;

      const disparo = await tx.pushDisparo.findUniqueOrThrow({
        where: { id: disparoId },
        select: { marketingAuditLogId: true },
      });
      if (disparo.marketingAuditLogId) {
        await tx.marketingNotificationAuditLog.updateMany({
          where: {
            id: disparo.marketingAuditLogId,
            status: { in: LOG_ABERTO },
          },
          data: {
            status: 'FAILED',
            errorMessage: erro.slice(0, 500),
            processedAt: agora,
          },
        });
      }
      return true;
    });
  }

  /** Fecha como falho um log que não chegou a ter disparo. */
  async falharLog(auditId: number, erro: string, agora: Date) {
    const { count } =
      await this.prisma.marketingNotificationAuditLog.updateMany({
        where: { id: auditId, status: { in: LOG_ABERTO } },
        data: {
          status: 'FAILED',
          errorMessage: erro.slice(0, 500),
          processedAt: agora,
        },
      });
    return count === 1;
  }

  // ----------------------------------------------------------------- envio

  /** Entregas do disparo depois de `aposId`, em ordem, com o que decide a página. */
  blocoDeEntregas(
    disparoId: number,
    aposId: number,
    limite: number,
  ): Promise<Array<{ id: number; estado: string; tentativas: number }>> {
    return this.prisma.pushEntrega.findMany({
      where: { disparoId, id: { gt: aposId } },
      select: { id: true, estado: true, tentativas: true },
      orderBy: { id: 'asc' },
      take: limite,
    });
  }

  /** Entregas da página que ainda estão abertas. */
  entregasDaPagina(
    disparoId: number,
    pagina: PaginaDeEntregas,
  ): Promise<EntregaParaEnvio[]> {
    return this.prisma.pushEntrega.findMany({
      where: {
        disparoId,
        id: { gte: pagina.deId, lte: pagina.ateId },
        ...ENTREGA_ABERTA,
      },
      select: { id: true, userId: true, expoPushToken: true },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Grava o resultado de um lote numa transação só:
   *  - aceita → `ENVIADA` + ticket, e a linha da caixa de entrada — só para
   *    as entregas que ESTA chamada tirou de `PENDENTE`/`FALHA` (uma linha
   *    por entrega, mesmo com o lote reexecutado);
   *  - recusada → `RECUSADA` + motivo; token morto é apagado do usuário se
   *    ainda for o mesmo;
   *  - sem resposta → `FALHA` (volta a ser tentada);
   *  - contadores e batimento do disparo.
   */
  gravarResultadoDoLote(
    disparo: Pick<DisparoPush, 'id' | 'titulo' | 'corpo' | 'dados'>,
    resultado: ResultadoDoLote,
    agora: Date,
  ): Promise<{ enviadas: number; recusadas: number; falhas: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const gravadas: typeof resultado.aceitas = [];
        for (const aceita of resultado.aceitas) {
          const { count } = await tx.pushEntrega.updateMany({
            where: { id: aceita.id, estado: ESTADOS_DE_ENVIO },
            data: {
              estado: 'ENVIADA',
              ticketId: aceita.ticketId,
              erro: null,
              enviadaEm: agora,
              tentativas: { increment: 1 },
            },
          });
          if (count === 1) gravadas.push(aceita);
        }

        if (gravadas.length > 0) {
          // Usuário apagado depois da seleção não tem caixa de entrada: sem
          // este filtro a FK derrubaria a transação e o lote seria reenviado.
          const existentes = await tx.user.findMany({
            where: { id: { in: gravadas.map((g) => g.userId) } },
            select: { id: true },
          });
          const vivos = new Set(existentes.map((u) => u.id));
          const linhas = gravadas
            .filter((g) => vivos.has(g.userId))
            .map((g) => ({
              userId: g.userId,
              expoPushToken: g.expoPushToken,
              title: disparo.titulo,
              body: disparo.corpo,
              data: (disparo.dados ?? {}) as Prisma.InputJsonValue,
              sentAt: agora,
            }));
          if (linhas.length > 0) {
            await tx.notification.createMany({ data: linhas });
          }
        }

        let recusadas = 0;
        for (const [erro, ids] of porErro(resultado.recusadas)) {
          const { count } = await tx.pushEntrega.updateMany({
            where: { id: { in: ids }, estado: ESTADOS_DE_ENVIO },
            data: {
              estado: 'RECUSADA',
              erro,
              tentativas: { increment: 1 },
            },
          });
          recusadas += count;
        }
        await this.apagarTokensMortos(tx, resultado.recusadas);

        let falhas = 0;
        for (const [erro, ids] of porErro(resultado.falhas)) {
          const { count } = await tx.pushEntrega.updateMany({
            where: { id: { in: ids }, estado: ESTADOS_DE_ENVIO },
            data: { estado: 'FALHA', erro, tentativas: { increment: 1 } },
          });
          falhas += count;
        }

        await tx.pushDisparo.updateMany({
          where: { id: disparo.id, estado: 'ENVIANDO' },
          data: {
            totalEnviadas: { increment: gravadas.length },
            totalRecusadas: { increment: recusadas },
            batimentoEm: agora,
          },
        });

        return { enviadas: gravadas.length, recusadas, falhas };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  }

  /** Ainda há entrega a (re)enviar? Para na primeira que encontrar. */
  /**
   * CPFs dos destinatários cuja entrega terminou sem push aceito
   * (`RECUSADA` ou `FALHA`), para a consulta do painel. Limitado: a lista é
   * para conferência manual, não para exportação.
   */
  async cpfsSemEnvio(disparoId: number, maximo: number): Promise<string[]> {
    const entregas = await this.prisma.pushEntrega.findMany({
      where: { disparoId, estado: { in: ['RECUSADA', 'FALHA'] } },
      select: { userId: true },
      orderBy: { id: 'asc' },
      take: maximo,
    });
    if (entregas.length === 0) return [];
    const usuarios = await this.prisma.user.findMany({
      where: { id: { in: entregas.map((e) => e.userId) } },
      select: { cpf: true },
    });
    return usuarios.map((u) => u.cpf).filter((cpf): cpf is string => !!cpf);
  }

  async temAbertas(disparoId: number): Promise<boolean> {
    const aberta = await this.prisma.pushEntrega.findFirst({
      where: { disparoId, ...ENTREGA_ABERTA },
      select: { id: true },
    });
    return aberta !== null;
  }

  async contarPorEstado(
    disparoId: number,
  ): Promise<Partial<Record<EstadoDaEntrega, number>>> {
    const grupos = await this.prisma.pushEntrega.groupBy({
      by: ['estado'],
      where: { disparoId },
      _count: { _all: true },
    });
    return Object.fromEntries(
      grupos.map((g) => [g.estado, g._count._all]),
    ) as Partial<Record<EstadoDaEntrega, number>>;
  }

  /**
   * `ENVIANDO → CONCLUIDO | FALHOU` com as contagens reais, e o log do
   * painel fechado na mesma transação (`SENT | FAILED`). `false` = outra
   * execução já tinha fechado.
   */
  fechar(
    disparoId: number,
    desfecho: DesfechoDoDisparo,
    contagem: ContagemDoDisparo,
    agora: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.pushDisparo.updateMany({
        where: { id: disparoId, estado: 'ENVIANDO' },
        data: {
          estado: desfecho.estado,
          totalEnviadas: contagem.enviadas,
          totalRecusadas: contagem.recusadas,
          totalFalhas: contagem.falhas,
          concluidoEm: agora,
          batimentoEm: agora,
        },
      });
      if (count !== 1) return false;

      const disparo = await tx.pushDisparo.findUniqueOrThrow({
        where: { id: disparoId },
        select: { marketingAuditLogId: true },
      });
      if (!disparo.marketingAuditLogId) return true;

      const log = await tx.marketingNotificationAuditLog.findUnique({
        where: { id: disparo.marketingAuditLogId },
        select: { skippedCount: true },
      });
      await tx.marketingNotificationAuditLog.updateMany({
        where: { id: disparo.marketingAuditLogId, status: { in: LOG_ABERTO } },
        data: {
          status: desfecho.statusDoLog,
          sentCount: contagem.enviadas,
          // Ignorados na seleção (já gravados) + não enviados no disparo.
          skippedCount:
            (log?.skippedCount ?? 0) + (contagem.total - contagem.enviadas),
          errorMessage: desfecho.erro,
          processedAt: agora,
        },
      });
      return true;
    });
  }

  /** Disparo vencido: o que ainda estava aberto não será mais enviado. */
  async expirarAbertas(disparoId: number): Promise<number> {
    const { count } = await this.prisma.pushEntrega.updateMany({
      where: { disparoId, ...ENTREGA_ABERTA },
      data: {
        estado: 'FALHA',
        erro: ERRO_DISPARO_EXPIRADO,
        tentativas: MAX_TENTATIVAS_DA_ENTREGA,
      },
    });
    return count;
  }

  // --------------------------------------------------------------- recibos

  async entregasAguardandoRecibo(
    disparoId: number,
    aposId: number,
    limite: number,
  ): Promise<Array<EntregaParaEnvio & { ticketId: string }>> {
    const linhas = await this.prisma.pushEntrega.findMany({
      where: {
        disparoId,
        id: { gt: aposId },
        estado: 'ENVIADA',
        ticketId: { not: null },
      },
      select: { id: true, userId: true, expoPushToken: true, ticketId: true },
      orderBy: { id: 'asc' },
      take: limite,
    });
    return linhas.map((l) => ({ ...l, ticketId: l.ticketId as string }));
  }

  /** `ENVIADA → ENTREGUE | RECUSADA` pelo recibo; apaga token morto. */
  gravarRecibos(
    entregues: number[],
    recusadas: EntregaRecusada[],
    agora: Date,
  ): Promise<{ entregues: number; recusadas: number }> {
    return this.prisma.$transaction(async (tx) => {
      let totalEntregues = 0;
      if (entregues.length > 0) {
        const { count } = await tx.pushEntrega.updateMany({
          where: { id: { in: entregues }, estado: 'ENVIADA' },
          data: { estado: 'ENTREGUE', reciboEm: agora },
        });
        totalEntregues = count;
      }

      let totalRecusadas = 0;
      for (const [erro, ids] of porErro(recusadas)) {
        const { count } = await tx.pushEntrega.updateMany({
          where: { id: { in: ids }, estado: 'ENVIADA' },
          data: { estado: 'RECUSADA', erro, reciboEm: agora },
        });
        totalRecusadas += count;
      }
      await this.apagarTokensMortos(tx, recusadas);

      return { entregues: totalEntregues, recusadas: totalRecusadas };
    });
  }

  // ------------------------------------------------------------- varredura

  /**
   * Disparos abertos sem sinal de vida desde `limite`: criação que não
   * terminou (`CRIADO`) ou envio sem batimento (`ENVIANDO`).
   */
  disparosParados(limite: Date, maximo: number): Promise<DisparoPush[]> {
    return this.prisma.pushDisparo.findMany({
      where: {
        estado: { in: ['CRIADO', 'ENVIANDO'] },
        OR: [
          { batimentoEm: { lt: limite } },
          { batimentoEm: null, criadoEm: { lt: limite } },
        ],
      },
      orderBy: { id: 'asc' },
      take: maximo,
    });
  }

  /**
   * Marca o batimento para assumir a retomada. Condicionado ao batimento
   * lido: de duas varreduras, só uma retoma.
   */
  async reivindicarRetomada(
    disparo: Pick<DisparoPush, 'id' | 'estado' | 'batimentoEm'>,
    agora: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.pushDisparo.updateMany({
      where: {
        id: disparo.id,
        estado: disparo.estado,
        batimentoEm: disparo.batimentoEm,
      },
      data: { batimentoEm: agora },
    });
    return count === 1;
  }

  /**
   * Log aberto (`REQUESTED`/`SENDING`) sem disparo e parado desde `limite`:
   * o processo morreu antes de criar o disparo (ou o log é de antes do envio
   * por lotes). Nada garante o que foi enviado, então não é reenviado.
   */
  async falharLogsOrfaos(limite: Date, agora: Date): Promise<number> {
    const abertos = await this.prisma.marketingNotificationAuditLog.findMany({
      where: { status: { in: LOG_ABERTO }, updatedAt: { lt: limite } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 500,
    });
    if (abertos.length === 0) return 0;

    const ids = abertos.map((l) => l.id);
    const comDisparo = await this.prisma.pushDisparo.findMany({
      where: { marketingAuditLogId: { in: ids } },
      select: { marketingAuditLogId: true },
    });
    const ligados = new Set(comDisparo.map((d) => d.marketingAuditLogId));
    const orfaos = ids.filter((id) => !ligados.has(id));
    if (orfaos.length === 0) return 0;

    const { count } =
      await this.prisma.marketingNotificationAuditLog.updateMany({
        where: {
          id: { in: orfaos },
          status: { in: LOG_ABERTO },
          updatedAt: { lt: limite },
        },
        data: {
          status: 'FAILED',
          errorMessage:
            'Envio interrompido antes de concluir; não foi reenviado para evitar duplicidade.',
          processedAt: agora,
        },
      });
    return count;
  }

  /** Quando começou o disparo mais antigo ainda aberto (`null` = nenhum). */
  async inicioDoMaisAntigoAberto(): Promise<Date | null> {
    const disparo = await this.prisma.pushDisparo.findFirst({
      where: { estado: { in: ['CRIADO', 'ENVIANDO'] } },
      orderBy: { criadoEm: 'asc' },
      select: { criadoEm: true },
    });
    return disparo?.criadoEm ?? null;
  }

  private async apagarTokensMortos(
    tx: Prisma.TransactionClient,
    recusadas: EntregaRecusada[],
  ): Promise<void> {
    for (const recusada of recusadas) {
      if (!recusada.tokenMorto) continue;
      // Só apaga se o usuário ainda estiver com o token que foi recusado: se
      // ele já registrou outro (reinstalou o app), o novo fica.
      await tx.user.updateMany({
        where: { id: recusada.userId, expoPushToken: recusada.expoPushToken },
        data: { expoPushToken: null },
      });
    }
  }
}

/** Agrupa ids de entrega pela mensagem de erro (um `UPDATE` por mensagem). */
function porErro(
  entregas: Array<{ id: number; erro: string }>,
): Map<string, number[]> {
  const grupos = new Map<string, number[]>();
  for (const entrega of entregas) {
    const ids = grupos.get(entrega.erro);
    if (ids) ids.push(entrega.id);
    else grupos.set(entrega.erro, [entrega.id]);
  }
  return grupos;
}

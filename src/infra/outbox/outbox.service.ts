import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { metricas } from 'src/infra/observability/metricas';
import { NomeDaFila } from 'src/queue/filas';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';

/** Cliente do Prisma dentro de uma transação interativa. */
type Transacao = Prisma.TransactionClient;

export interface EventoDeOutbox {
  /** Nome estável do evento: `boleto.pago`, `revistoria.aprovada`. */
  tipo: string;
  /**
   * Chave de negócio (id do boleto, da revistoria...). Com o tipo, impede
   * gravar o mesmo evento duas vezes e vira o `jobId` da publicação.
   */
  chave: string;
  base?: string | null;
  payload: Record<string, unknown>;
}

export interface DestinoDeOutbox {
  fila: NomeDaFila;
  /** Nome do job publicado na fila. */
  job: string;
}

/** Eventos lidos por rodada do despachante. */
const LOTE = 50;
/** Tentativas de publicação antes de marcar o evento como FALHOU. */
const MAX_TENTATIVAS = 10;

interface LinhaPendente {
  id: number;
}

/**
 * Outbox: efeitos entre módulos nos fluxos em que "gravei no banco" e
 * "publiquei na fila" precisam acontecer juntos.
 *
 * Quem gera o fato chama `registrar` DENTRO da própria transação — o evento
 * entra ou sai com o fato. O despachante (job periódico, papel `worker`)
 * publica os pendentes na fila de destino. Se o Redis estiver fora no
 * instante do commit, o evento espera na tabela em vez de se perder.
 *
 * A publicação é "ao menos uma vez": o job leva `jobId` derivado do evento,
 * e o consumidor precisa ser idempotente pela chave de negócio.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly destinos = new Map<string, DestinoDeOutbox>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly produtor: ProdutorDeFilas,
  ) {}

  /** Declara para qual fila vai cada tipo de evento (feito pelos módulos no boot). */
  registrarDestino(tipo: string, destino: DestinoDeOutbox): void {
    this.destinos.set(tipo, destino);
  }

  /**
   * Grava o evento na transação informada. Evento repetido (mesmo tipo e
   * chave) é ignorado — o fato já foi registrado.
   */
  async registrar(tx: Transacao, evento: EventoDeOutbox): Promise<void> {
    await tx.outboxEvento.createMany({
      data: [
        {
          tipo: evento.tipo,
          chave: evento.chave,
          baseOrigin: evento.base ?? null,
          payload: evento.payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * Publica um lote de eventos pendentes. Seguro para rodar em vários
   * processos: cada linha é travada com `SKIP LOCKED`, então dois
   * despachantes nunca pegam o mesmo evento.
   *
   * O "agora" vem da aplicação, por parâmetro, e não do `NOW()` do banco:
   * o Prisma grava as datas em UTC, e um servidor MySQL com fuso de sessão
   * diferente (ex.: `-03:00`) compararia o horário gravado com o relógio
   * local dele — o evento recém-registrado só sairia horas depois.
   *
   * @returns quantos eventos foram publicados nesta rodada.
   */
  async despachar(agora: Date = new Date()): Promise<number> {
    let publicados = 0;

    for (;;) {
      const publicou = await this.prisma.$transaction(
        async (tx) => {
          const [linha] = await tx.$queryRaw<LinhaPendente[]>`
            SELECT id FROM OutboxEvento
             WHERE estado = 'PENDENTE' AND proximaTentativaEm <= ${agora}
             ORDER BY id
             LIMIT 1
             FOR UPDATE SKIP LOCKED`;
          if (!linha) return false;

          const evento = await tx.outboxEvento.findUniqueOrThrow({
            where: { id: linha.id },
          });
          await this.publicar(tx, evento);
          return true;
        },
        { timeout: 20_000 },
      );

      if (!publicou) break;
      publicados += 1;
      if (publicados >= LOTE) break;
    }

    return publicados;
  }

  private async publicar(
    tx: Transacao,
    evento: {
      id: number;
      tipo: string;
      chave: string;
      baseOrigin: string | null;
      payload: Prisma.JsonValue;
      tentativas: number;
    },
  ): Promise<void> {
    const destino = this.destinos.get(evento.tipo);

    try {
      if (!destino) {
        throw new Error(
          `Nenhum destino registrado para o evento ${evento.tipo}`,
        );
      }
      await this.produtor.enfileirar(
        destino.fila,
        destino.job,
        evento.payload as Record<string, unknown>,
        { base: evento.baseOrigin, jobId: `outbox-${evento.id}` },
      );
      await tx.outboxEvento.update({
        where: { id: evento.id },
        data: {
          estado: 'PUBLICADO',
          publicadoEm: new Date(),
          ultimoErro: null,
        },
      });
      metricas.filaProcessados.inc({
        queue: 'outbox',
        name: evento.tipo,
        resultado: 'ok',
      });
    } catch (erro) {
      const tentativas = evento.tentativas + 1;
      const esgotou = tentativas >= MAX_TENTATIVAS;
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      // Intervalo crescente: 5 s, 10 s, 20 s... até 10 min.
      const esperaMs = Math.min(600_000, 5_000 * 2 ** (tentativas - 1));

      await tx.outboxEvento.update({
        where: { id: evento.id },
        data: {
          tentativas,
          estado: esgotou ? 'FALHOU' : 'PENDENTE',
          proximaTentativaEm: new Date(Date.now() + esperaMs),
          ultimoErro: mensagem.slice(0, 500),
        },
      });
      metricas.filaProcessados.inc({
        queue: 'outbox',
        name: evento.tipo,
        resultado: 'falha',
      });
      if (esgotou) {
        metricas.dlqJobs.inc({ queue: 'outbox' });
        this.logger.error(
          `Evento de outbox ${evento.tipo}#${evento.id} (chave=${evento.chave}) FALHOU após ${tentativas} tentativas: ${mensagem}`,
        );
      } else {
        this.logger.warn(
          `Evento de outbox ${evento.tipo}#${evento.id} não publicado (tentativa ${tentativas}/${MAX_TENTATIVAS}): ${mensagem}`,
        );
      }
    }
  }
}

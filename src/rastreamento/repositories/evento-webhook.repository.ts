import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { EventoM7, instanteDoEvento } from 'src/rastreamento/domain/evento-m7';

export interface EventoRegistrado {
  id: number;
  /** `true`: a linha foi criada agora; `false`: o evento já estava gravado. */
  novo: boolean;
  /** O evento já foi tratado por inteiro (push decidido e enviado). */
  processado: boolean;
}

function ehViolacaoDeUnicidade(erro: unknown): boolean {
  return (erro as { code?: unknown } | null)?.code === 'P2002';
}

/** `enviado_em` de um payload gravado (texto JSON, como sempre foi gravado). */
function enviadoEmDoPayload(payload: unknown): number | null {
  let objeto: unknown = payload;
  if (typeof payload === 'string') {
    try {
      objeto = JSON.parse(payload);
    } catch {
      // Linha antiga com payload ilegível: sem data, não entra na comparação.
      return null;
    }
  }
  if (!objeto || typeof objeto !== 'object') return null;
  return instanteDoEvento((objeto as { enviado_em?: unknown }).enviado_em);
}

/**
 * `VehicleWebhookEvent`: uma linha por evento da M7. O índice único de
 * `eventoHash` é o que impede a segunda gravação do mesmo evento.
 */
@Injectable()
export class EventoWebhookRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Grava o evento. Se o hash já existe (reentrega, retry do job), devolve a
   * linha existente em vez de criar outra. Qualquer outro erro de banco
   * propaga — o job falha e tenta de novo.
   */
  async registrar(
    evento: EventoM7,
    payload: unknown,
  ): Promise<EventoRegistrado> {
    try {
      const criado = await this.prisma.vehicleWebhookEvent.create({
        data: {
          chassi: evento.chassi,
          evento: evento.evento,
          tipoevento: evento.tipoevento,
          provider: 'M7',
          payload: JSON.stringify(payload),
          eventoHash: evento.hash,
        },
        select: { id: true },
      });
      return { id: criado.id, novo: true, processado: false };
    } catch (erro) {
      if (!ehViolacaoDeUnicidade(erro)) throw erro;
    }

    const existente = await this.prisma.vehicleWebhookEvent.findUnique({
      where: { eventoHash: evento.hash },
      select: { id: true, processed: true },
    });
    if (!existente) {
      // A linha que causou o conflito sumiu (expurgo no meio do caminho).
      throw new Error(
        `Evento ${evento.hash} em conflito de unicidade, mas não encontrado`,
      );
    }
    return { id: existente.id, novo: false, processado: existente.processed };
  }

  /**
   * Instante (`enviado_em`) do último evento já processado para o mesmo
   * veículo e tipo. `null` se ainda não houve nenhum.
   */
  async ultimoProcessadoEm(
    evento: Pick<EventoM7, 'chassi' | 'tipoevento' | 'evento'>,
  ): Promise<number | null> {
    const ultimo = await this.prisma.vehicleWebhookEvent.findFirst({
      where: {
        chassi: evento.chassi,
        tipoevento: evento.tipoevento,
        evento: evento.evento,
        processed: true,
        eventoHash: { not: null },
      },
      orderBy: { id: 'desc' },
      select: { payload: true },
    });
    return ultimo ? enviadoEmDoPayload(ultimo.payload) : null;
  }

  /**
   * Marca o evento como processado. Devolve `false` se outra execução já
   * tinha marcado.
   */
  async marcarProcessado(id: number): Promise<boolean> {
    const { count } = await this.prisma.vehicleWebhookEvent.updateMany({
      where: { id, processed: false },
      data: { processed: true },
    });
    return count === 1;
  }
}

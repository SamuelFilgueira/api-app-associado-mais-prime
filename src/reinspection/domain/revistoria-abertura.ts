import type { ReinspectionStatus } from '@prisma/client';

/**
 * Janela em que um segundo pedido de criação, idêntico, é tratado como
 * repetição do primeiro (toque duplo, retry do cliente HTTP). Passado esse
 * tempo vale o fluxo de sempre: nova tentativa cria nova revistoria.
 */
export const JANELA_DE_REPETICAO_MS = 2 * 60_000;

export interface UltimaRevistoriaDoVeiculo {
  status: ReinspectionStatus;
  vehicleType: string;
  codigoVeiculo: number | null;
  createdAt: Date;
  totalFotos: number;
}

export interface PedidoDeAbertura {
  vehicleType: string;
  codigoVeiculo?: number | null;
}

/**
 * O pedido é repetição da última revistoria do veículo quando ela acabou de
 * nascer, ainda não recebeu foto e foi aberta com os mesmos dados. Nesse caso
 * devolve-se a mesma revistoria em vez de criar outra.
 *
 * Revistoria PENDENTE que já tem foto NÃO é reaproveitada: é o envio que
 * parou no meio, e o app recomeça com uma revistoria nova.
 */
export function ehRepeticaoDaAbertura(
  ultima: UltimaRevistoriaDoVeiculo | null,
  pedido: PedidoDeAbertura,
  agora: Date,
): boolean {
  if (!ultima) return false;
  if (ultima.status !== 'PENDENTE' || ultima.totalFotos > 0) return false;
  if (ultima.vehicleType !== pedido.vehicleType) return false;
  if ((ultima.codigoVeiculo ?? null) !== (pedido.codigoVeiculo ?? null)) {
    return false;
  }
  const idadeMs = agora.getTime() - ultima.createdAt.getTime();
  return idadeMs >= 0 && idadeMs <= JANELA_DE_REPETICAO_MS;
}

/**
 * Devolve o event loop ao Node entre blocos de um laço longo.
 *
 * Um histórico de 31 dias tem dezenas de milhares de pontos; percorrê-los de
 * uma vez segura o processo inteiro — as outras requisições (inclusive a
 * posição em tempo real) ficam paradas até o laço acabar. `setImmediate`
 * deixa o I/O pendente rodar antes do próximo bloco; o resultado do laço não
 * muda.
 */
export function cederEventLoop(): Promise<void> {
  return new Promise((resolver) => setImmediate(resolver));
}

/** Itens processados entre uma cessão e outra, quando o chamador não informa. */
export const ITENS_POR_BLOCO = 2_000;

/**
 * Percorre `itens` em ordem, cedendo o event loop a cada `tamanhoDoBloco`.
 * `processar` é síncrono e pode manter estado entre os itens.
 */
export async function percorrerEmBlocos<T>(
  itens: readonly T[],
  processar: (item: T, indice: number) => void,
  tamanhoDoBloco: number = ITENS_POR_BLOCO,
): Promise<void> {
  for (let i = 0; i < itens.length; i++) {
    processar(itens[i], i);
    if ((i + 1) % tamanhoDoBloco === 0) await cederEventLoop();
  }
}

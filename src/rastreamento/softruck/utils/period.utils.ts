/**
 * Converte uma data (objeto Date) para o formato ACC da Softruck: YYYYMMDD (número).
 *
 * @example
 * converterDataParaAcc(new Date('2026-05-15')) // → 20260515
 */
export function converterDataParaAcc(date: Date): number {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return parseInt(`${year}${month}${day}`, 10);
}

/**
 * Gera a lista de valores ACC entre duas datas ISO (inclusivo nos dois extremos).
 *
 * @param dataInicial - Data inicial no formato YYYY-MM-DD
 * @param dataFinal   - Data final no formato YYYY-MM-DD
 * @returns           - Lista de números no formato YYYYMMDD
 *
 * @example
 * gerarListaAcc('2026-05-01', '2026-05-03')
 * // → [20260501, 20260502, 20260503]
 */
export function gerarListaAcc(
  dataInicial: string,
  dataFinal: string,
): number[] {
  const accs: number[] = [];
  const inicio = new Date(dataInicial + 'T00:00:00');
  const fim = new Date(dataFinal + 'T00:00:00');

  const cursor = new Date(inicio);
  while (cursor <= fim) {
    accs.push(converterDataParaAcc(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return accs;
}

/**
 * Processa um array de itens com concorrência limitada, evitando sobrecarga
 * na API externa. Os itens são processados em lotes de `concorrencia` por vez.
 *
 * @param itens       - Lista de itens a processar
 * @param concorrencia - Número máximo de requests simultâneos por lote
 * @param processar   - Função assíncrona que processa cada item
 * @returns           - Resultados na mesma ordem dos itens de entrada
 */
export async function processarComConcorrencia<T, R>(
  itens: T[],
  concorrencia: number,
  processar: (item: T) => Promise<R>,
): Promise<R[]> {
  const resultados: R[] = [];

  for (let i = 0; i < itens.length; i += concorrencia) {
    const lote = itens.slice(i, i + concorrencia);
    const resultadosLote = await Promise.all(lote.map(processar));
    resultados.push(...resultadosLote);
  }

  return resultados;
}

/**
 * Converte um número ACC (YYYYMMDD) de volta para uma string de data ISO (YYYY-MM-DD).
 *
 * @example
 * converterAccParaData(20260502) // → "2026-05-02"
 */
export function converterAccParaData(acc: number): string {
  const str = String(acc);
  const year = str.slice(0, 4);
  const month = str.slice(4, 6);
  const day = str.slice(6, 8);
  return `${year}-${month}-${day}`;
}

/**
 * Conta o número de dias entre duas datas ISO (inclusivo).
 */
export function contarDias(dataInicial: string, dataFinal: string): number {
  const inicio = new Date(dataInicial + 'T00:00:00');
  const fim = new Date(dataFinal + 'T00:00:00');
  const diffMs = fim.getTime() - inicio.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

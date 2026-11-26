/**
 * Total economizado devolvido pelo Clubgas (`totalEconomizado`, que vem como
 * texto) convertido em número. `null` quando o campo não veio ou não é
 * numérico — quem chama decide o que fazer sem o valor.
 */
export function interpretarTotalEconomizado(valor: unknown): number | null {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const numero = typeof valor === 'number' ? valor : parseFloat(valor);
  return Number.isFinite(numero) ? numero : null;
}

/**
 * O total lido do Clubgas deve substituir o gravado em `user.totalEconomizado`?
 * Só quando é maior: o total acumulado nunca diminui, e um valor igual ou
 * menor não traz informação nova.
 */
export function deveAtualizarTotalGravado(
  totalLido: number | null,
  totalGravado: number,
): totalLido is number {
  return totalLido !== null && totalLido > totalGravado;
}

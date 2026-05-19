/**
 * Chave com maior precisão para mapear resultados já resolvidos de volta ao PDF.
 */
export function normalizarCoord(lat: number, lng: number): string {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/**
 * Chave menos precisa para deduplicação e cache de geocoding.
 */
export function normalizarCoordParaCache(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

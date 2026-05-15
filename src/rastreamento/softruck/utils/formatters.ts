/** Formata timestamp Unix (segundos) para dd/MM/yyyy HH:mm */
export function formatarData(timestamp: number): string {
  const date = new Date(timestamp * 1000);

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

/** Formata duração em segundos para formato legível (ex: "1h 23m 45s"). */
export function formatarDuracao(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos < 0) return '0s';

  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  const segs = Math.floor(segundos % 60);

  const partes: string[] = [];
  if (horas > 0) partes.push(`${horas}h`);
  if (minutos > 0) partes.push(`${minutos}m`);
  if (segs > 0 || partes.length === 0) partes.push(`${segs}s`);

  return partes.join(' ');
}

/** Converte data no formato YYYYMMDD para dd/MM/yyyy. */
export function formatarDataYYYYMMDDParaBR(data: string): string {
  if (data.length !== 8) return data;

  const ano = data.slice(0, 4);
  const mes = data.slice(4, 6);
  const dia = data.slice(6, 8);

  return `${dia}/${mes}/${ano}`;
}

export function parseCoordinate(value: number | string): number {
  if (typeof value === 'number') {
    return value;
  }

  const normalized = value.trim().replace(',', '.');
  return Number(normalized);
}

/** Escapa conteúdo textual para evitar quebra de HTML no relatório. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Formata timestamp da Softruck, que pode ser Unix em segundos
 * (valor > 1 bilhão) ou data YYYYMMDD (valor < 30 milhões).
 */
export function formatarTimestampSoftruck(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'N/D';

  // YYYYMMDD: ~20 milhões | Unix timestamp 2026: ~1.7 bilhão
  if (value < 30_000_000) {
    return formatarDataYYYYMMDDParaBR(String(value));
  }

  return formatarData(value);
}

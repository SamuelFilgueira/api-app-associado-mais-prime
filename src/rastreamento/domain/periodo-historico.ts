/**
 * Validação pura dos parâmetros de histórico (chassi + intervalo de datas).
 */

/** `yyyy-mm-dd` que existe no calendário (2026-02-30 não vale). */
export function ehDataIsoValida(valor?: string): boolean {
  if (!valor) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;

  const [ano, mes, dia] = valor.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));

  return (
    data.getUTCFullYear() === ano &&
    data.getUTCMonth() === mes - 1 &&
    data.getUTCDate() === dia
  );
}

/**
 * Mensagem do primeiro problema encontrado nos parâmetros, ou `null` se
 * estão corretos. Os textos são os que o app já recebe.
 */
export function problemaNoPeriodoDeHistorico(
  chassi: string,
  dataInicial: string,
  dataFinal: string,
): string | null {
  if (!chassi) return 'Parâmetro chassi é obrigatório';
  if (!ehDataIsoValida(dataInicial)) {
    return 'Parâmetro dataInicial inválido. Use o formato yyyy-mm-dd';
  }
  if (!ehDataIsoValida(dataFinal)) {
    return 'Parâmetro dataFinal inválido. Use o formato yyyy-mm-dd';
  }
  if (dataInicial > dataFinal) {
    return 'Parâmetro dataInicial não pode ser maior que dataFinal';
  }
  return null;
}

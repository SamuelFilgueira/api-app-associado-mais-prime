/**
 * Utilitários de data compartilhados (formato brasileiro usado pela API SGA/Hinova).
 *
 * O processo roda com TZ=America/Sao_Paulo (definido em src/main.ts), portanto
 * os métodos locais de Date (getDate/getMonth/...) já refletem o fuso da operação.
 */

/** Formata uma data no padrão dd/mm/yyyy (formato das APIs SGA). */
export function formatDateBR(date: Date): string {
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  const ano = date.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

/**
 * Converte "dd/mm/yyyy" em Date local (meia-noite). Retorna null se inválida.
 */
export function parseDateBR(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;

  const dia = Number(match[1]);
  const mes = Number(match[2]);
  const ano = Number(match[3]);
  const date = new Date(ano, mes - 1, dia);

  // Rejeita datas inexistentes (ex.: 31/02) que o construtor "rola" para o mês seguinte
  if (
    date.getFullYear() !== ano ||
    date.getMonth() !== mes - 1 ||
    date.getDate() !== dia
  ) {
    return null;
  }

  return date;
}

/**
 * Converte datas vindas do SGA em Date local. A documentação diz dd/mm/yyyy,
 * mas o retorno real do endpoint /listar/boleto-associado/periodo usa
 * yyyy-mm-dd (com ou sem hora). Aceita os dois formatos; null se inválida
 * (inclusive "0000-00-00", usado pelo SGA como "sem data").
 */
export function parseDateSga(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const texto = value.trim();
  if (!texto) return null;

  const br = parseDateBR(texto);
  if (br) return br;

  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (!iso) return null;

  const ano = Number(iso[1]);
  const mes = Number(iso[2]);
  const dia = Number(iso[3]);
  if (ano === 0 || mes === 0 || dia === 0) return null;

  const date = new Date(ano, mes - 1, dia);
  if (
    date.getFullYear() !== ano ||
    date.getMonth() !== mes - 1 ||
    date.getDate() !== dia
  ) {
    return null;
  }
  return date;
}

/** Retorna uma nova data com o horário zerado (meia-noite local). */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Soma (ou subtrai, se negativo) dias corridos, preservando meia-noite local. */
export function addDays(date: Date, days: number): Date {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Quantidade de dias do mês (mês 1–12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Compara apenas a parte de data (ano/mês/dia) de duas datas locais. */
export function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Converte uma data local para o instante UTC equivalente à mesma data
 * (00:00Z). Necessário ao persistir em colunas Prisma `@db.Date`, que
 * gravam a parte de data do valor em UTC.
 */
export function toUtcDateOnly(date: Date): Date {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
}

/** Formata como yyyy-mm-dd (para logs e chaves). */
export function formatDateISO(date: Date): string {
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${mes}-${dia}`;
}

/**
 * "Dia" da promoção = data em America/Sao_Paulo, sempre calculada com o fuso
 * explícito (não depende do TZ do processo: seed e scripts rodam sem o
 * `process.env.TZ` do `main.ts`).
 */
const FORMATADOR_DIA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Offset fixo de Brasília (o horário de verão foi extinto em 2019). */
const OFFSET_SAO_PAULO = '-03:00';

/** "yyyy-mm-dd" do instante em São Paulo. */
export function diaSaoPaulo(agora: Date = new Date()): string {
  return FORMATADOR_DIA.format(agora);
}

/** Converte "yyyy-mm-dd" no `Date` (00:00Z) que o Prisma grava em `@db.Date`. */
export function diaParaDate(dia: string): Date {
  return new Date(`${dia}T00:00:00.000Z`);
}

/** Lê uma coluna `@db.Date` (00:00Z) de volta para "yyyy-mm-dd". */
export function dateParaDia(
  valor: Date | string | null | undefined,
): string | null {
  if (!valor) return null;
  if (typeof valor === 'string') return valor.slice(0, 10);
  return valor.toISOString().slice(0, 10);
}

/** Soma dias a um "yyyy-mm-dd". */
export function somarDias(dia: string, dias: number): string {
  const data = diaParaDate(dia);
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

/** Instante em que o dia seguinte começa em São Paulo (libera a próxima coleta). */
export function proximaViradaDoDia(agora: Date = new Date()): Date {
  const amanha = somarDias(diaSaoPaulo(agora), 1);
  return new Date(`${amanha}T00:00:00.000${OFFSET_SAO_PAULO}`);
}

/** Início do dia (00:00 de São Paulo) como instante. */
export function inicioDoDiaSaoPaulo(dia: string): Date {
  return new Date(`${dia}T00:00:00.000${OFFSET_SAO_PAULO}`);
}

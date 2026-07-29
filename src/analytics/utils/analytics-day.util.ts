const SAO_PAULO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Dia de negócio de um instante, no fuso de São Paulo ('YYYY-MM-DD').
 *
 * O corte anterior era meia-noite UTC (`toISOString().slice(0,10)`), que cai
 * às 21h em Brasília — pico de uso do app. Sessões entre 21h e 0h eram
 * atribuídas ao dia seguinte e podiam contar em dois dias ao cruzar o corte.
 * Fuso fixado aqui (não herdado de process.env.TZ) para o bucketing não mudar
 * conforme o ambiente que executa o worker.
 */
export function saoPauloDayString(instant: Date): string {
  return SAO_PAULO_DAY.format(instant);
}

/**
 * O dia como valor de coluna `DATE`. O driver grava a parte de data do UTC,
 * por isso a âncora é a meia-noite UTC do dia calculado — mesma convenção que
 * o código sempre usou para escrita e leitura.
 */
export function saoPauloDay(instant: Date): Date {
  return new Date(`${saoPauloDayString(instant)}T00:00:00.000Z`);
}

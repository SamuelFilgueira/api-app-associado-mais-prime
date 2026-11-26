/**
 * Datas da Alloyal no formato que o app exibe (pt-BR).
 *
 * `fuso` existe para os testes: em produção fica `undefined` e vale o fuso
 * do processo (`TZ`, fixado em `main.ts`), como sempre foi.
 */
type Instante = string | number | Date | null | undefined;

const opcoes = (fuso?: string): Intl.DateTimeFormatOptions | undefined =>
  fuso ? { timeZone: fuso } : undefined;

/** `25/11/2026, 12:30:00`; vazio quando não há data. */
export function dataHoraLocal(valor: Instante, fuso?: string): string {
  return valor ? new Date(valor).toLocaleString('pt-BR', opcoes(fuso)) : '';
}

/** `25/11/2026`; vazio quando não há data. */
export function dataLocal(valor: Instante, fuso?: string): string {
  return valor ? new Date(valor).toLocaleDateString('pt-BR', opcoes(fuso)) : '';
}

/** `12:30`; vazio quando não há horário. */
export function horaMinutoLocal(valor: Instante, fuso?: string): string {
  return valor
    ? new Date(valor).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        ...opcoes(fuso),
      })
    : '';
}

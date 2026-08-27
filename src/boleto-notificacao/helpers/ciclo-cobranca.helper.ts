import { addDays, daysInMonth, startOfDay } from 'src/shared/date.util';

export interface CicloCobrancaParams {
  diasVencimento: number[];
  fallbackMesCurto: number;
}

/**
 * Conjunto efetivo de dias de gatilho para um mês.
 *
 * Regra: dias configurados que existem no mês entram normalmente; para cada
 * dia configurado que NÃO existe (ex.: 30 em fevereiro), o dia de fallback
 * (default 28) entra no lugar — desde que ele próprio exista no mês.
 */
export function diasEfetivosDoMes(
  ano: number,
  mes: number,
  params: CicloCobrancaParams,
): number[] {
  const ultimoDia = daysInMonth(ano, mes);
  const efetivos = new Set<number>();

  for (const dia of params.diasVencimento) {
    if (dia <= ultimoDia) {
      efetivos.add(dia);
    } else if (params.fallbackMesCurto <= ultimoDia) {
      efetivos.add(params.fallbackMesCurto);
    }
  }

  return Array.from(efetivos).sort((a, b) => a - b);
}

/** Indica se a data é um dia de gatilho (considerando a exceção de meses curtos). */
export function isDataGatilho(
  data: Date,
  params: CicloCobrancaParams,
): boolean {
  const efetivos = diasEfetivosDoMes(
    data.getFullYear(),
    data.getMonth() + 1,
    params,
  );
  return efetivos.includes(data.getDate());
}

/**
 * Data-alvo de um momento do ciclo: data de referência menos o offset em
 * dias corridos (D0 = hoje, D+5 = hoje − 5, D+6 = hoje − 6).
 */
export function calcularDataAlvo(dataReferencia: Date, offset: number): Date {
  return addDays(startOfDay(dataReferencia), -offset);
}

/** Remove máscara e repõe zeros à esquerda; null se não for um CPF plausível. */
export function normalizarCpf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const texto =
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  const digitos = texto.replace(/\D/g, '');
  if (!digitos || digitos.length > 14) return null;
  // CNPJ (associado pessoa jurídica) chega no mesmo campo `cpf` com 14 dígitos
  if (digitos.length > 11) return digitos.padStart(14, '0');
  return digitos.padStart(11, '0');
}

/** Mascara CPF para logs/respostas administrativas (mantém 3 primeiros e 2 últimos dígitos). */
export function mascararCpf(cpf: string | null | undefined): string {
  if (!cpf) return 'ausente';
  if (cpf.length < 6) return '***';
  return `${cpf.slice(0, 3)}******${cpf.slice(-2)}`;
}

/** Substitui placeholders {vencimento} e {quantidade} no texto da mensagem. */
export function renderizarMensagem(
  template: string,
  valores: { vencimento: string; quantidade: number },
): string {
  return template
    .replace(/\{vencimento\}/g, valores.vencimento)
    .replace(/\{quantidade\}/g, String(valores.quantidade));
}

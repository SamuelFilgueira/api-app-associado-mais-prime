import { addDays, startOfDay } from 'src/shared/date.util';

// Régua v2 (10/09/2026): não há mais "dias fixos de gatilho" — a âncora é o
// vencimento EFETIVO (data_vencimento do SGA, já prorrogado para dia útil),
// e cada etapa é consultada todos os dias.

/**
 * Data-alvo de uma etapa pós-vencimento: data de referência menos o offset em
 * dias corridos (D0 = hoje, D+1 = hoje − 1, ..., D+20 = hoje − 20).
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

/** Valores disponíveis para os tokens da régua. */
export interface TokensMensagem {
  /** Primeiro nome do associado. */
  nome: string;
  /** Placa do veículo (primeiro veículo do boleto). */
  placa: string;
  /** Competência por extenso (ex.: "Setembro"), derivada de mes_referente. */
  mes: string;
  /** Vencimento efetivo em DD/MM. */
  data: string;
  /** Vencimento efetivo em dd/mm/yyyy (compatibilidade). */
  vencimento: string;
  /** Quantidade de boletos do associado nesse vencimento. */
  quantidade: number;
}

/**
 * Substitui os tokens da régua no texto da mensagem:
 * {nome}, {placa}, {mes}, {data}, {vencimento}, {quantidade}.
 */
export function renderizarMensagem(
  template: string,
  valores: TokensMensagem,
): string {
  return template
    .replace(/\{nome\}/g, valores.nome)
    .replace(/\{placa\}/g, valores.placa)
    .replace(/\{mes\}/g, valores.mes)
    .replace(/\{data\}/g, valores.data)
    .replace(/\{vencimento\}/g, valores.vencimento)
    .replace(/\{quantidade\}/g, String(valores.quantidade));
}

/** Primeiro nome com capitalização simples (KAIO SILVA → Kaio). */
export function primeiroNome(nomeCompleto: string | null | undefined): string {
  const primeiro = (nomeCompleto ?? '').trim().split(/\s+/)[0] ?? '';
  if (!primeiro) return 'Associado';
  return (
    primeiro.charAt(0).toLocaleUpperCase('pt-BR') +
    primeiro.slice(1).toLocaleLowerCase('pt-BR')
  );
}

const MESES_PT = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

/** Converte mes_referente ("09/2026") na competência por extenso ("Setembro"). */
export function mesPorExtenso(mesReferente: string | null | undefined): string {
  const match = (mesReferente ?? '').trim().match(/^(\d{1,2})\/\d{4}$/);
  const numero = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(numero) || numero < 1 || numero > 12) {
    return mesReferente?.trim() || 'este mês';
  }
  return MESES_PT[numero - 1];
}

/**
 * Tabela OFICIAL de situações de boleto do SGA (Hinova).
 * Não existe situação "Vencido": boleto vencido e não pago permanece ABERTO (2).
 *
 * | código | descrição              | inadimplência | pago |
 * |--------|------------------------|---------------|------|
 * | 1      | BAIXADO                | N             | SIM  |
 * | 2      | ABERTO                 | Y             | NÃO  |
 * | 3      | CANCELADO              | N             | NÃO  |
 * | 4      | BAIXADO C/ PENDÊNCIA   | N             | SIM  |
 * | 999    | EXCLUÍDO               | N             | NÃO  |
 */
export enum SituacaoBoletoSga {
  BAIXADO = '1',
  ABERTO = '2',
  CANCELADO = '3',
  BAIXADO_COM_PENDENCIA = '4',
  EXCLUIDO = '999',
}

export const SITUACAO_BOLETO_SGA_DESCRICAO: Record<SituacaoBoletoSga, string> =
  {
    [SituacaoBoletoSga.BAIXADO]: 'BAIXADO',
    [SituacaoBoletoSga.ABERTO]: 'ABERTO',
    [SituacaoBoletoSga.CANCELADO]: 'CANCELADO',
    [SituacaoBoletoSga.BAIXADO_COM_PENDENCIA]: 'BAIXADO C/ PENDÊNCIA',
    [SituacaoBoletoSga.EXCLUIDO]: 'EXCLUÍDO',
  };

/** Normaliza o código vindo do SGA (pode chegar como number ou string). */
export function normalizarCodigoSituacao(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim();
  return '';
}

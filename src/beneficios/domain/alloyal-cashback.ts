import type {
  AlloyalCashbackRecordDto,
  AlloyalCashbackRecordsResponseDto,
} from 'src/beneficios/dto/alloyal-cashback.dto';

/**
 * Extrato de cashback: valores sempre numéricos e textos sempre presentes,
 * mesmo quando a Alloyal omite o campo (ou devolve o corpo vazio).
 */
export function mapearExtratoDeCashback(
  corpo: unknown,
): AlloyalCashbackRecordsResponseDto {
  const dados = (corpo ?? {}) as Record<string, unknown>;
  const numero = (valor: unknown) => Number(valor ?? 0);
  const texto = (valor: unknown) => (valor ?? '') as string;

  return {
    total_amount: numero(dados.total_amount),
    pending_amount: numero(dados.pending_amount),
    approved_amount: numero(dados.approved_amount),
    available_amount: numero(dados.available_amount),
    in_transfer_amount: numero(dados.in_transfer_amount),
    transferred_amount: numero(dados.transferred_amount),
    title: texto(dados.title),
    subtitle: texto(dados.subtitle),
    status: texto(dados.status),
    cashback_records: Array.isArray(dados.cashback_records)
      ? (dados.cashback_records as AlloyalCashbackRecordDto[])
      : [],
  };
}

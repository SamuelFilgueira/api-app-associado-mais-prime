/**
 * Convenção do campo `BoletoNotificacaoLog.expoErro`: `<CODIGO>: <mensagem>`.
 *
 * O modelo não tem coluna que separe falha transitória de definitiva; quem
 * decide é o código à frente do texto:
 *  - `SEND_ERROR`: a chamada ao Expo não teve resposta (rede, timeout, 5xx).
 *    Nada foi entregue ao Expo — é a ÚNICA falha que volta a ser elegível.
 *  - qualquer outro (`DeviceNotRegistered`, `MessageTooBig`, `TICKET_ERROR`,
 *    `RECEIPT_ERROR`...): o Expo recusou. Repetir não muda nada.
 */
export const CODIGO_FALHA_DE_TRANSPORTE = 'SEND_ERROR';

const TAMANHO_MAXIMO = 255; // VarChar(255)

function descrever(codigo: string, mensagem: string | undefined): string {
  return `${codigo}: ${mensagem ?? 'erro desconhecido'}`.slice(
    0,
    TAMANHO_MAXIMO,
  );
}

export function descreverFalhaDeTransporte(mensagem?: string): string {
  return descrever(CODIGO_FALHA_DE_TRANSPORTE, mensagem);
}

/** Recusa do Expo no ticket (`TICKET_ERROR`) ou no recibo (`RECEIPT_ERROR`). */
export function descreverRecusa(
  detalhe: string | undefined,
  mensagem: string | undefined,
  codigoPadrao: 'TICKET_ERROR' | 'RECEIPT_ERROR',
): string {
  return descrever(detalhe ?? codigoPadrao, mensagem);
}

export function ehFalhaDeTransporte(
  expoErro: string | null | undefined,
): boolean {
  return (
    typeof expoErro === 'string' &&
    expoErro.startsWith(`${CODIGO_FALHA_DE_TRANSPORTE}:`)
  );
}

/** Fatia em lotes de até `tamanho` itens, preservando a ordem. */
export function fatiar<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }
  return lotes;
}

import {
  BoletoReativacaoDefinitivoError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';

/**
 * Status HTTP do SGA tratados como instabilidade (vale retry):
 * 401 (sessão caiu e a reautenticação também falhou), 403 (bloqueio de token
 * por rajada), 408/429 (limite) e qualquer 5xx. Os demais 4xx são resposta
 * de negócio (veículo/associado inexistente, payload inválido) e não mudam
 * com retry.
 */
export function ehStatusInstavel(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

function resumirCorpo(data: unknown): string {
  if (data == null) return '';
  const texto = typeof data === 'string' ? data : JSON.stringify(data);
  return texto.length > 300 ? `${texto.slice(0, 300)}…` : texto;
}

/** Converte uma resposta HTTP de erro do SGA no erro tipado adequado. */
export function erroDaRespostaSga(
  etapa: string,
  status: number,
  data: unknown,
): BoletoReativacaoInstabilidadeError | BoletoReativacaoDefinitivoError {
  const mensagem =
    `${etapa}: SGA respondeu HTTP ${status} ${resumirCorpo(data)}`.trim();
  return ehStatusInstavel(status)
    ? new BoletoReativacaoInstabilidadeError(mensagem, etapa, status)
    : new BoletoReativacaoDefinitivoError(mensagem, etapa, status);
}

/**
 * Converte uma exceção lançada durante a chamada ao SGA (timeout, rede,
 * falha de login na Hinova) em instabilidade. Erros já tipados passam direto.
 */
export function erroDaExcecaoSga(
  etapa: string,
  error: unknown,
): BoletoReativacaoInstabilidadeError | BoletoReativacaoDefinitivoError {
  if (
    error instanceof BoletoReativacaoInstabilidadeError ||
    error instanceof BoletoReativacaoDefinitivoError
  ) {
    return error;
  }
  const mensagem = error instanceof Error ? error.message : String(error);
  return new BoletoReativacaoInstabilidadeError(
    `${etapa}: falha na chamada ao SGA (${mensagem})`,
    etapa,
  );
}

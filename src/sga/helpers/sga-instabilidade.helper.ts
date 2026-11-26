import axios from 'axios';
import { FalhaAutenticacaoSga } from 'src/integrations/hinova/sga-auth.service';
import {
  DomainError,
  ErroDeAplicacao,
  ehErroTransitorio,
} from 'src/shared/erros/erros';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';
import {
  BoletoReativacaoDefinitivoError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';

type ErroDoBoleto =
  | BoletoReativacaoInstabilidadeError
  | BoletoReativacaoDefinitivoError;

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

function mensagemDe(error: unknown): string {
  if (error instanceof BaseNaoResolvidaError) {
    return `base do associado não resolvida (${error.contexto})`;
  }
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Converte uma resposta HTTP de erro do SGA no erro tipado adequado. */
export function erroDaRespostaSga(
  etapa: string,
  status: number,
  data: unknown,
): ErroDoBoleto {
  const mensagem =
    `${etapa}: SGA respondeu HTTP ${status} ${resumirCorpo(data)}`.trim();
  return ehStatusInstavel(status)
    ? new BoletoReativacaoInstabilidadeError(mensagem, etapa, status)
    : new BoletoReativacaoDefinitivoError(mensagem, etapa, status);
}

/**
 * Converte uma exceção lançada DURANTE a chamada ao SGA (timeout, rede,
 * falha de login na Hinova, disjuntor aberto) em instabilidade. Erros já
 * tipados passam direto; o que a taxonomia da aplicação diz que não adianta
 * repetir (regra de negócio, credencial ausente para a base) é definitivo.
 */
export function erroDaExcecaoSga(etapa: string, error: unknown): ErroDoBoleto {
  if (
    error instanceof BoletoReativacaoInstabilidadeError ||
    error instanceof BoletoReativacaoDefinitivoError
  ) {
    return error;
  }
  if (error instanceof ErroDeAplicacao && !ehErroTransitorio(error)) {
    return new BoletoReativacaoDefinitivoError(
      `${etapa}: ${mensagemDe(error)}`,
      etapa,
    );
  }
  return new BoletoReativacaoInstabilidadeError(
    `${etapa}: falha na chamada ao SGA (${mensagemDe(error)})`,
    etapa,
  );
}

/** Códigos de erro de rede/soquete do Node e do axios. */
const CODIGOS_DE_REDE: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_NETWORK',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * Prisma: banco fora, conexão caída, pool esgotado e deadlock. O restante
 * (única, FK, valor inválido, registro inexistente) é erro de dados.
 */
const CODIGOS_DE_BANCO_FORA: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2034',
]);

/**
 * O erro é, comprovadamente, instabilidade — rede, timeout, 5xx, bloqueio
 * ou login recusado na Hinova, ou infraestrutura própria fora?
 *
 * É o inverso de `ehErroTransitorio`, que trata o desconhecido como
 * transitório: aqui o desconhecido NÃO entra no retry. Uma exceção de
 * programação (ou de dados) repetida a cada 5 minutos por 24 horas não
 * conserta nada e esconde o defeito.
 */
export function ehInstabilidadeComprovada(error: unknown): boolean {
  if (error instanceof BoletoReativacaoInstabilidadeError) return true;
  if (error instanceof BoletoReativacaoDefinitivoError) return false;
  if (error instanceof ErroDeAplicacao) return ehErroTransitorio(error);
  if (error instanceof FalhaAutenticacaoSga) return true;

  if (axios.isAxiosError(error)) {
    return error.response ? ehStatusInstavel(error.response.status) : true;
  }

  const codigo = (error as { code?: unknown } | null)?.code;
  return (
    typeof codigo === 'string' &&
    (CODIGOS_DE_REDE.has(codigo) || CODIGOS_DE_BANCO_FORA.has(codigo))
  );
}

/**
 * Classifica qualquer erro que escape de uma tentativa de gerar o boleto:
 * instabilidade comprovada entra no retry; todo o resto (regra, dados, base
 * não resolvida, exceção inesperada) é definitivo.
 */
export function classificarErroDoBoleto(error: unknown): ErroDoBoleto {
  if (
    error instanceof BoletoReativacaoInstabilidadeError ||
    error instanceof BoletoReativacaoDefinitivoError
  ) {
    return error;
  }
  return ehInstabilidadeComprovada(error)
    ? new BoletoReativacaoInstabilidadeError(
        `falha de infraestrutura (${mensagemDe(error)})`,
        'infraestrutura',
      )
    : new BoletoReativacaoDefinitivoError(
        `erro não recuperável: ${mensagemDe(error)}`,
        'erro-definitivo',
      );
}

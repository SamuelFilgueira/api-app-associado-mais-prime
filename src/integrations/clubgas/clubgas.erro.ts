import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import axios from 'axios';

/** Endpoint do Clubgas em que a falha ocorreu. */
export type ClubgasOperacao = 'POSTOS' | 'CARTAO_VIRTUAL' | 'TOTAL_ECONOMIZADO';

/**
 * Classificação da falha, gravada em `ClubgasErroLog.categoria` e devolvida ao
 * app como `code` (`CLUBGAS_<CATEGORIA>`).
 *
 * Recusas do próprio Clubgas (ele responde com a mensagem em `errors`):
 * - `DADOS_INVALIDOS`   "Dados inválidos." — o campo `Cpf` só aceita 11 dígitos
 *                       (CNPJ, máscara ou tamanho errado caem aqui)
 * - `PLACA_INVALIDA`    "Formato de placa inválido: ..." ou lista de postos
 *                       vazia e sem paginação
 * - `CARTAO_RECUSADO`   "Não foi possível gerar seu cartão virtual. ..." — o par
 *                       placa + CPF não foi aceito para a entidade do token
 * - `RECUSADO`          qualquer outro 4xx
 *
 * Falhas de infraestrutura:
 * - `ERRO_CLUBGAS`      5xx do Clubgas
 * - `TIMEOUT`           sem resposta dentro do tempo limite
 * - `SEM_CONEXAO`       sem resposta (DNS, conexão recusada…)
 * - `RESPOSTA_INVALIDA` 2xx com `isValid: false` ou corpo fora do contrato
 * - `CONFIGURACAO`      token/base do Clubgas não configurados neste deploy
 *
 * Falha antes da chamada:
 * - `VEICULO_SEM_PLACA` o associado não tem veículo ativo com placa para o
 *                       chassi informado
 */
export type ClubgasErroCategoria =
  | 'DADOS_INVALIDOS'
  | 'PLACA_INVALIDA'
  | 'CARTAO_RECUSADO'
  | 'RECUSADO'
  | 'ERRO_CLUBGAS'
  | 'TIMEOUT'
  | 'SEM_CONEXAO'
  | 'RESPOSTA_INVALIDA'
  | 'CONFIGURACAO'
  | 'VEICULO_SEM_PLACA';

/** Categorias que indicam problema nosso ou do Clubgas, e não do cadastro. */
export const CLUBGAS_FALHAS_DE_INFRA: ReadonlySet<ClubgasErroCategoria> =
  new Set([
    'ERRO_CLUBGAS',
    'TIMEOUT',
    'SEM_CONEXAO',
    'RESPOSTA_INVALIDA',
    'CONFIGURACAO',
  ]);

const MENSAGEM_INDISPONIVEL =
  'O desconto em combustível está indisponível no momento. Tente novamente em instantes.';

/** Falha em uma chamada ao Clubgas, já classificada. */
export class ClubgasErro extends Error {
  readonly operacao: ClubgasOperacao;
  readonly categoria: ClubgasErroCategoria;
  /** Status HTTP devolvido pelo Clubgas; `null` quando não houve resposta. */
  readonly httpStatus: number | null;
  /** Corpo devolvido pelo Clubgas, guardado para o log no banco. */
  readonly resposta: unknown;
  readonly duracaoMs: number | null;

  constructor(dados: {
    operacao: ClubgasOperacao;
    categoria: ClubgasErroCategoria;
    mensagem: string;
    httpStatus?: number | null;
    resposta?: unknown;
    duracaoMs?: number | null;
  }) {
    super(dados.mensagem);
    this.name = 'ClubgasErro';
    this.operacao = dados.operacao;
    this.categoria = dados.categoria;
    this.httpStatus = dados.httpStatus ?? null;
    this.resposta = dados.resposta ?? null;
    this.duracaoMs = dados.duracaoMs ?? null;
  }
}

function normalizarTexto(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

/**
 * Mensagens devolvidas pelo Clubgas: `errors: string[]` nas recusas (4xx) ou
 * `message` nos erros internos (5xx).
 */
export function mensagensDoClubgas(corpo: unknown): string[] {
  if (!corpo || typeof corpo !== 'object') return [];
  const { errors, message } = corpo as { errors?: unknown; message?: unknown };

  const mensagens = (Array.isArray(errors) ? errors : [])
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .map((item) => normalizarTexto(item ?? ''))
    .filter((item) => item !== '');

  if (mensagens.length === 0 && typeof message === 'string') {
    const texto = normalizarTexto(message);
    if (texto) mensagens.push(texto);
  }
  return mensagens;
}

function categorizar(status: number, mensagem: string): ClubgasErroCategoria {
  if (status >= 500) return 'ERRO_CLUBGAS';
  if (/formato de placa inv[aá]lido/i.test(mensagem)) return 'PLACA_INVALIDA';
  if (/dados inv[aá]lidos/i.test(mensagem)) return 'DADOS_INVALIDOS';
  if (/cart[aã]o virtual/i.test(mensagem)) return 'CARTAO_RECUSADO';
  return status >= 400 ? 'RECUSADO' : 'RESPOSTA_INVALIDA';
}

/** Converte a exceção lançada pelo axios em `ClubgasErro`. */
export function clubgasErroDeFalha(
  operacao: ClubgasOperacao,
  falha: unknown,
  duracaoMs: number,
): ClubgasErro {
  if (axios.isAxiosError(falha) && falha.response) {
    const { status, data } = falha.response;
    const mensagem =
      mensagensDoClubgas(data).join(' ') || `Clubgas respondeu HTTP ${status}`;
    return new ClubgasErro({
      operacao,
      categoria: categorizar(status, mensagem),
      mensagem,
      httpStatus: status,
      resposta: data,
      duracaoMs,
    });
  }

  // Sem resposta. Só `code` e `message` entram no erro: `config` carrega o
  // header Authorization e nunca deve ser logado nem persistido.
  const codigo = axios.isAxiosError(falha) ? falha.code : undefined;
  const detalhe = falha instanceof Error ? falha.message : String(falha);
  const timeout = codigo === 'ECONNABORTED' || codigo === 'ETIMEDOUT';
  return new ClubgasErro({
    operacao,
    categoria: timeout ? 'TIMEOUT' : 'SEM_CONEXAO',
    mensagem: codigo ? `${codigo}: ${detalhe}` : detalhe,
    duracaoMs,
  });
}

/**
 * Valida o corpo de uma resposta 2xx. Devolve `null` quando está tudo certo,
 * ou o erro quando o Clubgas sinaliza falha (`isValid: false` / `errors`) ou
 * não devolve um objeto JSON.
 */
export function clubgasErroDeCorpo(
  operacao: ClubgasOperacao,
  httpStatus: number,
  corpo: unknown,
  duracaoMs: number,
): ClubgasErro | null {
  if (!corpo || typeof corpo !== 'object') {
    return new ClubgasErro({
      operacao,
      categoria: 'RESPOSTA_INVALIDA',
      mensagem: 'Clubgas respondeu sem um corpo JSON',
      httpStatus,
      resposta: corpo,
      duracaoMs,
    });
  }

  const { isValid, errors } = corpo as { isValid?: unknown; errors?: unknown };
  const temErros = Array.isArray(errors) && errors.length > 0;
  if (isValid !== false && !temErros) return null;

  const mensagem =
    mensagensDoClubgas(corpo).join(' ') ||
    'Clubgas respondeu com isValid=false';
  return new ClubgasErro({
    operacao,
    categoria: categorizar(httpStatus, mensagem),
    mensagem,
    httpStatus,
    resposta: corpo,
    duracaoMs,
  });
}

/**
 * Exceção HTTP devolvida ao app, no formato `{ statusCode, code, message }`
 * (mesmo de `direct-partners` e `associado-sorte`).
 *
 * Nas recusas, `message` é a mensagem do próprio Clubgas — é ela que diz ao
 * associado o que fazer. Nas falhas de infraestrutura a mensagem é genérica e
 * o detalhe fica só no `ClubgasErroLog`.
 */
export function clubgasErroParaHttp(erro: ClubgasErro): HttpException {
  const code = `CLUBGAS_${erro.categoria}`;

  switch (erro.categoria) {
    case 'DADOS_INVALIDOS':
    case 'PLACA_INVALIDA':
    case 'CARTAO_RECUSADO':
    case 'RECUSADO':
      return new UnprocessableEntityException({
        statusCode: 422,
        code,
        message: erro.message,
      });
    case 'VEICULO_SEM_PLACA':
      // Mesmo corpo que estas rotas já devolviam antes do log.
      return new NotFoundException(erro.message);
    case 'TIMEOUT':
      return new GatewayTimeoutException({
        statusCode: 504,
        code,
        message: MENSAGEM_INDISPONIVEL,
      });
    case 'CONFIGURACAO':
      return new ServiceUnavailableException({
        statusCode: 503,
        code,
        message: MENSAGEM_INDISPONIVEL,
      });
    default:
      return new BadGatewayException({
        statusCode: 502,
        code,
        message: MENSAGEM_INDISPONIVEL,
      });
  }
}

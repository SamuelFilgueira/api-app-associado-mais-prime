import { IntegrationError, TipoFalhaIntegracao } from 'src/shared/erros/erros';

export const VENDOR_ALLOYAL = 'alloyal';

/**
 * Operações da Alloyal: rótulo da métrica (`vendor_requests_total`) e do
 * log. Conjunto fechado — nunca um id, CPF ou URL.
 */
export type OperacaoAlloyal =
  | 'login'
  | 'categorias'
  | 'organizacoes_da_categoria'
  | 'organizacoes'
  | 'organizacoes_proximas'
  | 'destaques_proximos'
  | 'destaques_online'
  | 'filiais'
  | 'promocoes'
  | 'cashback_extrato'
  | 'cashback_resgate'
  | 'usuario_buscar'
  | 'usuario_criar'
  | 'usuario_atualizar'
  | 'cupons_da_organizacao'
  | 'cupons_da_filial'
  | 'cupom_detalhe'
  | 'cupom_resgatar_com_codigo'
  | 'pedidos'
  | 'cupom_resgatar';

/**
 * O que a operação espera no corpo de uma resposta 2xx:
 *  - `lista`: um array JSON;
 *  - `objeto`: um objeto JSON (não array, não nulo);
 *  - `json`: qualquer JSON — só recusa texto solto (HTML de proxy, JSON
 *    truncado), que o axios entrega como string;
 *  - `ignorado`: o corpo não é usado.
 */
export type CorpoEsperado = 'lista' | 'objeto' | 'json' | 'ignorado';

export interface ContextoDaChamada {
  operacao: OperacaoAlloyal;
  base: string;
}

const MAX_RESPOSTA_NO_ERRO = 500;

/** Resumo do corpo devolvido pela Alloyal, para o log (nunca vai ao app). */
export function resumirCorpo(corpo: unknown): string {
  if (corpo === undefined || corpo === null || corpo === '') return '(vazio)';
  let texto: string;
  try {
    texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  } catch {
    return '(não serializável)';
  }
  return texto.length > MAX_RESPOSTA_NO_ERRO
    ? `${texto.slice(0, MAX_RESPOSTA_NO_ERRO)}… (${texto.length} caracteres)`
    : texto;
}

function erro(
  contexto: ContextoDaChamada,
  tipo: TipoFalhaIntegracao,
  extras: {
    statusVendor?: number;
    motivo: string;
    respostaVendor?: unknown;
  },
): IntegrationError {
  return new IntegrationError({
    vendor: VENDOR_ALLOYAL,
    tipo,
    base: contexto.base,
    statusVendor: extras.statusVendor,
    detalhes: {
      operacao: contexto.operacao,
      motivo: extras.motivo,
      ...(extras.respostaVendor === undefined
        ? {}
        : { respostaVendor: resumirCorpo(extras.respostaVendor) }),
    },
  });
}

/**
 * Classifica o status HTTP devolvido pela Alloyal. `null` = 2xx.
 *
 * | Alloyal        | tipo            | repetir? |
 * |----------------|-----------------|----------|
 * | 401, 403       | `autenticacao`  | não      |
 * | 408, 429, 5xx  | `indisponivel`  | sim      |
 * | demais 4xx     | `recusado`      | não      |
 * | 1xx, 3xx       | `resposta_invalida` | não  |
 */
export function erroDeStatusAlloyal(
  contexto: ContextoDaChamada,
  status: number,
  corpo: unknown,
): IntegrationError | null {
  if (status >= 200 && status < 300) return null;

  let tipo: TipoFalhaIntegracao;
  if (status === 401 || status === 403) tipo = 'autenticacao';
  else if (status === 408 || status === 429 || status >= 500) {
    tipo = 'indisponivel';
  } else if (status >= 400) tipo = 'recusado';
  else tipo = 'resposta_invalida';

  return erro(contexto, tipo, {
    statusVendor: status,
    motivo: `Alloyal respondeu HTTP ${status}`,
    respostaVendor: corpo,
  });
}

/**
 * Valida o corpo de uma resposta 2xx contra o que a operação espera.
 * `null` = corpo aceito.
 */
export function erroDeCorpoAlloyal(
  contexto: ContextoDaChamada,
  esperado: CorpoEsperado,
  status: number,
  corpo: unknown,
): IntegrationError | null {
  const invalido = (motivo: string) =>
    erro(contexto, 'resposta_invalida', {
      statusVendor: status,
      motivo,
      respostaVendor: corpo,
    });

  switch (esperado) {
    case 'ignorado':
      return null;
    case 'lista':
      return Array.isArray(corpo)
        ? null
        : invalido('Alloyal não devolveu uma lista');
    case 'objeto':
      return corpo !== null &&
        typeof corpo === 'object' &&
        !Array.isArray(corpo)
        ? null
        : invalido('Alloyal não devolveu um objeto');
    case 'json':
      return typeof corpo === 'string' && corpo.trim() !== ''
        ? invalido('Alloyal devolveu texto no lugar de JSON')
        : null;
  }
}

/**
 * Classifica a exceção de uma chamada que não chegou a uma resposta HTTP
 * (prazo, DNS, conexão recusada). Só `code` e `message` entram no erro: o
 * `config` do axios carrega o api-secret e o token de employee, e nunca deve
 * ser logado nem guardado.
 */
export function erroDeFalhaAlloyal(
  contexto: ContextoDaChamada,
  falha: unknown,
): IntegrationError {
  if (falha instanceof IntegrationError) return falha;

  const codigo = (falha as { code?: unknown } | null)?.code;
  const mensagem = falha instanceof Error ? falha.message : String(falha);
  // ECONNABORTED: prazo do axios; ETIMEDOUT: prazo de conexão do socket.
  const prazo = codigo === 'ECONNABORTED' || codigo === 'ETIMEDOUT';

  return erro(contexto, prazo ? 'timeout' : 'indisponivel', {
    motivo: typeof codigo === 'string' ? `${codigo}: ${mensagem}` : mensagem,
  });
}

/** A chamada não pode sair: configuração da integração ausente. */
export function alloyalNaoConfigurada(
  contexto: ContextoDaChamada,
  oQueFalta: string,
): IntegrationError {
  return new IntegrationError({
    vendor: VENDOR_ALLOYAL,
    tipo: 'nao_configurada',
    base: contexto.base,
    message: 'Este serviço não está disponível para a sua conta no momento.',
    detalhes: { operacao: contexto.operacao, faltando: oQueFalta },
  });
}

/** A chamada exige a sessão do usuário e ela não veio completa. */
export function sessaoAlloyalAusente(
  contexto: ContextoDaChamada,
): IntegrationError {
  return erro(contexto, 'autenticacao', {
    motivo: 'Sessão do usuário na Alloyal ausente (uid, client, access-token)',
  });
}

/** O login respondeu 2xx sem os cabeçalhos que formam a sessão. */
export function loginSemSessao(
  contexto: ContextoDaChamada,
  status: number,
  cabecalhosRecebidos: string[],
): IntegrationError {
  return erro(contexto, 'resposta_invalida', {
    statusVendor: status,
    motivo: `Login sem os cabeçalhos de sessão (recebidos: ${cabecalhosRecebidos.join(', ') || 'nenhum'})`,
  });
}

/** Rótulo da métrica de vendor para uma falha já classificada. */
export function resultadoDaMetrica(falha: unknown): 'erro' | 'timeout' {
  return falha instanceof IntegrationError && falha.tipo === 'timeout'
    ? 'timeout'
    : 'erro';
}

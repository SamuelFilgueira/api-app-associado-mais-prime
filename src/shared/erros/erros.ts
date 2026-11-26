/**
 * Taxonomia de erros da aplicação. Três famílias, cada uma com um destino
 * conhecido no HTTP (filtro global) e na fila (classificação de retry):
 *
 * | Família            | Quando                          | HTTP            | Fila                        |
 * |--------------------|---------------------------------|-----------------|-----------------------------|
 * | `DomainError`      | regra de negócio violada        | 409 ou 422      | sem retry (fila de mortos)  |
 * | `IntegrationError` | falha de vendor                 | 502, 503 ou 504 | retry só se transitória     |
 * | `InfraError`       | banco, Redis, disco, fila       | 503             | retry                       |
 *
 * Todo erro carrega um `code` estável (o app e o painel decidem por ele, não
 * pelo texto) e uma mensagem que pode ir ao cliente. O detalhe técnico fica
 * em `causa` / `detalhes` e só aparece no log.
 */
export abstract class ErroDeAplicacao extends Error {
  abstract readonly familia: 'dominio' | 'integracao' | 'infra';

  constructor(
    readonly code: string,
    message: string,
    readonly detalhes?: Record<string, unknown>,
    readonly causa?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Regra de negócio violada. `status` 422 por padrão; 409 para conflito. */
export class DomainError extends ErroDeAplicacao {
  readonly familia = 'dominio' as const;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    opcoes: {
      status?: 400 | 403 | 404 | 409 | 422;
      detalhes?: Record<string, unknown>;
    } = {},
  ) {
    super(code, message, opcoes.detalhes);
    this.status = opcoes.status ?? 422;
  }
}

export type TipoFalhaIntegracao =
  /** O vendor não respondeu no prazo. */
  | 'timeout'
  /** Rede, DNS, 5xx, 429: vale tentar de novo. */
  | 'indisponivel'
  /** O circuito está aberto: a chamada nem saiu. */
  | 'circuito_aberto'
  /** 2xx com corpo que não é o esperado (HTML de proxy, JSON truncado). */
  | 'resposta_invalida'
  /** O vendor recusou a operação (4xx de negócio): repetir não muda nada. */
  | 'recusado'
  /** Credencial ou URL do vendor ausente para a base. */
  | 'nao_configurada'
  /** Credencial recusada pelo vendor (401/403 de autenticação). */
  | 'autenticacao';

const TRANSITORIAS: ReadonlySet<TipoFalhaIntegracao> = new Set([
  'timeout',
  'indisponivel',
  'circuito_aberto',
]);

/** Falha ao falar com um vendor (Hinova, M7, ClubGas, Expo...). */
export class IntegrationError extends ErroDeAplicacao {
  readonly familia = 'integracao' as const;
  readonly vendor: string;
  readonly tipo: TipoFalhaIntegracao;
  readonly base?: string;
  readonly statusVendor?: number;
  /** Vale repetir a chamada? */
  readonly transitoria: boolean;

  constructor(opcoes: {
    vendor: string;
    tipo: TipoFalhaIntegracao;
    base?: string;
    statusVendor?: number;
    /** Mensagem neutra para o cliente; o padrão não revela o vendor. */
    message?: string;
    detalhes?: Record<string, unknown>;
    causa?: unknown;
  }) {
    super(
      `INTEGRACAO_${opcoes.tipo.toUpperCase()}`,
      opcoes.message ??
        'Serviço temporariamente indisponível. Tente novamente em instantes.',
      opcoes.detalhes,
      opcoes.causa,
    );
    this.vendor = opcoes.vendor;
    this.tipo = opcoes.tipo;
    this.base = opcoes.base;
    this.statusVendor = opcoes.statusVendor;
    this.transitoria = TRANSITORIAS.has(opcoes.tipo);
  }

  /** Status HTTP que a API devolve para esta falha. */
  get statusHttp(): number {
    switch (this.tipo) {
      case 'timeout':
        return 504;
      case 'resposta_invalida':
      case 'recusado':
        return 502;
      default:
        return 503;
    }
  }
}

/** Falha de infraestrutura própria: banco, Redis, disco, fila. */
export class InfraError extends ErroDeAplicacao {
  readonly familia = 'infra' as const;

  constructor(
    readonly recurso: 'banco' | 'redis' | 'disco' | 'fila',
    message = 'Serviço temporariamente indisponível. Tente novamente em instantes.',
    causa?: unknown,
  ) {
    super(
      `INFRA_${recurso.toUpperCase()}_INDISPONIVEL`,
      message,
      undefined,
      causa,
    );
  }
}

/**
 * A integração `integracao` não tem credencial configurada para a base.
 * Substitui o `Error` genérico que virava 500 em tempo de execução.
 */
export function integracaoNaoConfigurada(
  vendor: string,
  base: string,
  oQueFalta: string,
): IntegrationError {
  return new IntegrationError({
    vendor,
    base,
    tipo: 'nao_configurada',
    message: 'Este serviço não está disponível para a sua conta no momento.',
    detalhes: { faltando: oQueFalta },
  });
}

/**
 * Códigos que dizem, com certeza, que repetir não adianta. Tudo o que não
 * está aqui é tratado como transitório: errar para o lado do retry custa
 * algumas tentativas; errar para o lado do "definitivo" perde o job.
 */
const CODIGOS_DEFINITIVOS: ReadonlySet<string> = new Set([
  // Prisma: violação de regra dos dados (única, FK, valor inválido, registro
  // inexistente). Pool esgotado, deadlock e conexão (P1xxx, P2024, P2034)
  // ficam de fora de propósito — são transitórios.
  'P2000',
  'P2002',
  'P2003',
  'P2004',
  'P2011',
  'P2012',
  'P2014',
  'P2025',
  // axios: o vendor recusou a requisição (4xx).
  'ERR_BAD_REQUEST',
]);

/** O erro vale uma nova tentativa (retry de job ou de leitura)? */
export function ehErroTransitorio(erro: unknown): boolean {
  if (erro instanceof IntegrationError) return erro.transitoria;
  if (erro instanceof InfraError) return true;
  if (erro instanceof DomainError) return false;

  // Exceção HTTP do Nest lançada dentro de um job: 4xx é recusa definitiva.
  const comStatus = erro as { getStatus?: unknown } | null;
  if (typeof comStatus?.getStatus === 'function') {
    const status = Number((comStatus.getStatus as () => unknown)());
    if (Number.isInteger(status)) return status >= 500 || status === 429;
  }

  const codigo = (erro as { code?: unknown } | null)?.code;
  if (typeof codigo === 'string' && CODIGOS_DEFINITIVOS.has(codigo)) {
    // 429 do vendor chega pelo axios como ERR_BAD_REQUEST: esse vale repetir.
    const status = (erro as { response?: { status?: unknown } }).response
      ?.status;
    return status === 429;
  }

  // Rede, timeout, 5xx, deadlock, pool esgotado e qualquer erro desconhecido.
  return true;
}

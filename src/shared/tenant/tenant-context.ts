import { BaseOrigin, isTenantBase } from 'src/config/tenant.config';
import { DomainError } from 'src/shared/erros/erros';

/**
 * De onde veio a base de uma unidade de trabalho.
 *  - `jwt`: claim `baseOrigin` do token (requisição do app).
 *  - `banco`: `user.baseOrigin`, lido para um token antigo sem a claim ou
 *    para um job legado sem a base no payload.
 *  - `job`: payload do job.
 *  - `webhook`: mapeamento explícito do evento para o veículo/usuário.
 *  - `painel`: informada pelo operador do painel (rota administrativa).
 */
export type OrigemDaBase = 'jwt' | 'banco' | 'job' | 'webhook' | 'painel';

/**
 * Contexto de tenant: criado UMA vez na borda (HTTP, job ou webhook) e
 * passado por parâmetro aos services. Não existe "base padrão" aqui — sem
 * base válida, a operação falha em vez de seguir com a credencial de outra.
 */
export interface TenantContext {
  readonly base: BaseOrigin;
  readonly origem: OrigemDaBase;
}

/**
 * A base não pôde ser determinada (cadastro sem base, job sem a base no
 * payload, valor que não pertence a este deploy).
 */
export class BaseNaoResolvidaError extends DomainError {
  constructor(contexto: string, valor?: unknown) {
    super(
      'BASE_NAO_RESOLVIDA',
      'Não foi possível identificar a base do seu cadastro. Entre em contato com a associação.',
      {
        status: 422,
        detalhes: undefined,
      },
    );
    this.contexto = contexto;
    this.valorRecebido =
      typeof valor === 'string' ? valor.slice(0, 60) : typeof valor;
  }

  /** Onde a resolução falhou — vai para o log, não para o cliente. */
  readonly contexto: string;
  readonly valorRecebido: string;
}

/**
 * Devolve a base se ela for uma das configuradas neste deploy; senão lança
 * `BaseNaoResolvidaError`. Substitui os `?? TENANT.defaultBase` espalhados:
 * cair em silêncio na base padrão fazia a operação seguir com a credencial
 * de outra base.
 */
export function exigirBase(valor: unknown, contexto: string): BaseOrigin {
  if (isTenantBase(valor)) return valor;
  throw new BaseNaoResolvidaError(contexto, valor);
}

export function criarTenantContext(
  valor: unknown,
  origem: OrigemDaBase,
  contexto: string,
): TenantContext {
  return { base: exigirBase(valor, contexto), origem };
}

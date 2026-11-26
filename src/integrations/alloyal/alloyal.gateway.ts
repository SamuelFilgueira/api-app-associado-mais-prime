import { BaseOrigin } from 'src/config/tenant.config';

/**
 * Sessão do usuário final na Alloyal. Vem do app a cada chamada (cabeçalhos
 * `uid`, `client` e `access-token`) e NÃO fica guardada no servidor. O
 * `api-secret` da base é acrescentado pelo client e nunca sai dele.
 */
export interface SessaoAlloyal {
  uid: string;
  client: string;
  accessToken: string;
}

/** Parâmetros de query já montados (sem valores vazios). */
export type ParametrosAlloyal = Record<string, string | number | boolean>;

/** Item de uma resposta da Alloyal, como veio (sem mapeamento). */
export type RegistroAlloyal = Record<string, unknown>;

/**
 * Porta da Alloyal (clube de vantagens). Os services de `src/beneficios`
 * dependem desta classe abstrata — que também é o token de injeção — e não
 * do axios: nos testes entra um fake, e URL, cabeçalhos, credencial por base,
 * prazo, métrica e classificação de erro ficam no adaptador
 * (`AlloyalClient`).
 *
 * Contrato de toda operação:
 *  - a base recebida decide a credencial; base inválida lança
 *    `BaseNaoResolvidaError` e credencial ausente lança `IntegrationError`
 *    (`nao_configurada`) — nunca cai na credencial de outra base;
 *  - toda falha de chamada sai como `IntegrationError` já classificada
 *    (`timeout`, `indisponivel`, `autenticacao`, `recusado`,
 *    `resposta_invalida`), com `statusVendor` e `detalhes.operacao`;
 *  - o que volta é o corpo da Alloyal como veio: o mapeamento para os DTOs
 *    do app é regra de `src/beneficios/domain`.
 */
export abstract class AlloyalGateway {
  // ------------------------------------------------------------- sessão
  /** `POST /auth/sign_in`. A sessão vem nos cabeçalhos da resposta. */
  abstract login(
    base: BaseOrigin,
    cpf: string,
    senha: string,
  ): Promise<SessaoAlloyal>;

  // ----------------------------------------------------------- catálogo
  /** `GET /categories`. */
  abstract listarCategorias(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<unknown>;

  /** `GET /categories/:id/organizations`. */
  abstract listarOrganizacoesDaCategoria(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    categoriaId: string,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]>;

  /** `GET /organizations`. */
  abstract listarOrganizacoes(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]>;

  /** `GET /organizations/nearest`. */
  abstract listarOrganizacoesProximas(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]>;

  /** `GET /organizations/highlights_nearby`. */
  abstract listarDestaquesProximos(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]>;

  /** `GET /organizations/highlights_online`. */
  abstract listarDestaquesOnline(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<RegistroAlloyal[]>;

  /** `GET /organizations/:id/branches`. */
  abstract listarFiliais(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]>;

  /** `GET /promotions`. */
  abstract listarPromocoes(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]>;

  // ----------------------------------------------------------- cashback
  /** `GET /cashback_records`. */
  abstract consultarCashback(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<unknown>;

  /** `POST /cashback_transfer_requests`. */
  abstract solicitarResgateDeCashback(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    corpo: unknown,
  ): Promise<void>;

  // ------------------------------------- usuários (credencial de employee)
  /** `GET /client/v2/businesses/:cnpj/users?term=<cpf>` (só ativos). */
  abstract buscarUsuariosPorCpf(
    base: BaseOrigin,
    cpf: string,
  ): Promise<unknown>;

  /** `POST /client/v2/businesses/:cnpj/users` (a Alloyal faz upsert por CPF). */
  abstract criarUsuario(base: BaseOrigin, corpo: unknown): Promise<unknown>;

  /**
   * `PATCH /client/v2/businesses/:cnpj/users/:identificador`. O identificador
   * é o CPF ou o id do usuário na Alloyal; só os dígitos vão para o caminho.
   */
  abstract atualizarUsuario(
    base: BaseOrigin,
    identificador: string,
    corpo: unknown,
  ): Promise<unknown>;

  // --------------------------------------------------- cupons e pedidos
  /** `GET /organizations/:id/coupons`. */
  abstract listarCuponsDaOrganizacao(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]>;

  /** `GET /organizations/:id/branches/:filial/coupons`. */
  abstract listarCuponsDaFilial(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    filialId: number,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]>;

  /** `GET /organizations/:id/coupons/:cupom`. */
  abstract detalharCupom(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    cupomId: number,
  ): Promise<RegistroAlloyal>;

  /** `GET /organizations/:id/orders?coupon_id=` — resgate com código. */
  abstract resgatarCupomComCodigo(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    params: ParametrosAlloyal,
  ): Promise<unknown>;

  /** `GET /orders` — resgates do usuário. */
  abstract listarPedidos(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<unknown>;

  /** `POST /orders` — resgate genérico. */
  abstract resgatarCupom(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    corpo: unknown,
  ): Promise<unknown>;
}

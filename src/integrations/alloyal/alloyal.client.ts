import { Injectable } from '@nestjs/common';
import { BaseOrigin } from 'src/config/tenant.config';
import { AlloyalHttp } from 'src/integrations/alloyal/alloyal-http';
import { OperacaoAlloyal } from 'src/integrations/alloyal/alloyal.erro';
import {
  AlloyalGateway,
  ParametrosAlloyal,
  RegistroAlloyal,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';

/**
 * Adaptador da porta `AlloyalGateway`: o catálogo das operações da Alloyal
 * (método, caminho e formato esperado de cada uma). Credencial por base,
 * cabeçalhos, prazo, métrica e classificação de erro são do `AlloyalHttp`.
 *
 *  - rotas de sessão (`<BASE_URL_ALLOYAL>/...`): em nome do usuário;
 *  - rotas administrativas (`/client/v2/businesses/<cnpj>/users`): com a
 *    credencial de employee da empresa.
 */
@Injectable()
export class AlloyalClient extends AlloyalGateway {
  constructor(private readonly http: AlloyalHttp) {
    super();
  }

  // ------------------------------------------------------------- sessão
  login(base: BaseOrigin, cpf: string, senha: string): Promise<SessaoAlloyal> {
    return this.http.login(base, cpf, senha);
  }

  // ----------------------------------------------------------- catálogo
  listarCategorias(base: BaseOrigin, sessao: SessaoAlloyal): Promise<unknown> {
    return this.http.comSessao(
      'categorias',
      base,
      sessao,
      '/categories',
      'json',
    );
  }

  listarOrganizacoesDaCategoria(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    categoriaId: string,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    // O id vem do caminho da rota do app, como texto: codificado, não
    // consegue sair de `/categories/<id>/organizations`.
    return this.lista(
      'organizacoes_da_categoria',
      base,
      sessao,
      `/categories/${encodeURIComponent(categoriaId)}/organizations`,
      params,
    );
  }

  listarOrganizacoes(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.lista('organizacoes', base, sessao, '/organizations', params);
  }

  listarOrganizacoesProximas(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.lista(
      'organizacoes_proximas',
      base,
      sessao,
      '/organizations/nearest',
      params,
    );
  }

  listarDestaquesProximos(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.lista(
      'destaques_proximos',
      base,
      sessao,
      '/organizations/highlights_nearby',
      params,
    );
  }

  listarDestaquesOnline(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.lista(
      'destaques_online',
      base,
      sessao,
      '/organizations/highlights_online',
    );
  }

  listarFiliais(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.lista(
      'filiais',
      base,
      sessao,
      `/organizations/${organizacaoId}/branches`,
      params,
    );
  }

  listarPromocoes(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.lista('promocoes', base, sessao, '/promotions', params);
  }

  // ----------------------------------------------------------- cashback
  consultarCashback(base: BaseOrigin, sessao: SessaoAlloyal): Promise<unknown> {
    return this.http.comSessao(
      'cashback_extrato',
      base,
      sessao,
      '/cashback_records',
      'json',
    );
  }

  async solicitarResgateDeCashback(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    corpo: unknown,
  ): Promise<void> {
    await this.http.comSessao(
      'cashback_resgate',
      base,
      sessao,
      '/cashback_transfer_requests',
      'ignorado',
      { metodo: 'POST', corpo },
    );
  }

  // ------------------------------------- usuários (credencial de employee)
  buscarUsuariosPorCpf(base: BaseOrigin, cpf: string): Promise<unknown> {
    return this.http.comoEmployee('usuario_buscar', base, '', false, {
      metodo: 'GET',
      params: { page: 1, active: true, term: cpf.replace(/\D/g, '') },
    });
  }

  criarUsuario(base: BaseOrigin, corpo: unknown): Promise<unknown> {
    return this.http.comoEmployee('usuario_criar', base, '', true, {
      metodo: 'POST',
      corpo,
    });
  }

  atualizarUsuario(
    base: BaseOrigin,
    identificador: string,
    corpo: unknown,
  ): Promise<unknown> {
    return this.http.comoEmployee(
      'usuario_atualizar',
      base,
      `/${identificador.replace(/\D/g, '')}`,
      true,
      { metodo: 'PATCH', corpo },
    );
  }

  // --------------------------------------------------- cupons e pedidos
  listarCuponsDaOrganizacao(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.lista(
      'cupons_da_organizacao',
      base,
      sessao,
      `/organizations/${organizacaoId}/coupons`,
      params,
    );
  }

  listarCuponsDaFilial(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    filialId: number,
    params: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.lista(
      'cupons_da_filial',
      base,
      sessao,
      `/organizations/${organizacaoId}/branches/${filialId}/coupons`,
      params,
    );
  }

  detalharCupom(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    cupomId: number,
  ): Promise<RegistroAlloyal> {
    return this.http.comSessao(
      'cupom_detalhe',
      base,
      sessao,
      `/organizations/${organizacaoId}/coupons/${cupomId}`,
      'objeto',
    ) as Promise<RegistroAlloyal>;
  }

  resgatarCupomComCodigo(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: number,
    params: ParametrosAlloyal,
  ): Promise<unknown> {
    return this.http.comSessao(
      'cupom_resgatar_com_codigo',
      base,
      sessao,
      `/organizations/${organizacaoId}/orders`,
      'json',
      { metodo: 'GET', params },
    );
  }

  listarPedidos(base: BaseOrigin, sessao: SessaoAlloyal): Promise<unknown> {
    return this.http.comSessao('pedidos', base, sessao, '/orders', 'json');
  }

  resgatarCupom(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    corpo: unknown,
  ): Promise<unknown> {
    return this.http.comSessao(
      'cupom_resgatar',
      base,
      sessao,
      '/orders',
      'json',
      { metodo: 'POST', corpo },
    );
  }

  /** `GET` de sessão cuja resposta tem de ser uma lista. */
  private lista(
    operacao: OperacaoAlloyal,
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    caminho: string,
    params?: ParametrosAlloyal,
  ): Promise<RegistroAlloyal[]> {
    return this.http.comSessao(operacao, base, sessao, caminho, 'lista', {
      metodo: 'GET',
      params,
    }) as Promise<RegistroAlloyal[]>;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { BaseOrigin } from 'src/config/tenant.config';
import { medirVendor } from 'src/infra/observability/metricas';
import { alloyalConfig } from 'src/config/integracoes.config';
import {
  ContextoDaChamada,
  CorpoEsperado,
  OperacaoAlloyal,
  VENDOR_ALLOYAL,
  alloyalNaoConfigurada,
  erroDeCorpoAlloyal,
  erroDeFalhaAlloyal,
  erroDeStatusAlloyal,
  loginSemSessao,
  resultadoDaMetrica,
  sessaoAlloyalAusente,
} from 'src/integrations/alloyal/alloyal.erro';
import {
  ParametrosAlloyal,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';
import { IntegrationError } from 'src/shared/erros/erros';
import { baseTag } from 'src/shared/log.util';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

export interface PedidoAlloyal {
  metodo: 'GET' | 'POST' | 'PATCH';
  params?: ParametrosAlloyal;
  corpo?: unknown;
}

/**
 * Transporte HTTP da Alloyal: o ÚNICO ponto da aplicação que conhece o
 * endereço, os cabeçalhos e as credenciais dela. O `AlloyalClient` descreve
 * as operações; aqui cada chamada ganha:
 *
 *  - a credencial da base recebida (nunca a de outra): `api-secret` nas
 *    rotas de sessão, CNPJ do business nas administrativas;
 *  - prazo (`ALLOYAL_TIMEOUT_MS`);
 *  - métrica (`vendor_requests_total{vendor="alloyal",base,operacao}`);
 *  - classificação: status fora de 2xx, corpo fora do esperado e falha de
 *    rede saem como `IntegrationError`. Quem chama nunca vê o erro do axios,
 *    que carrega as credenciais no `config`;
 *  - uma linha de log por falha, com a operação, o status e o corpo
 *    DEVOLVIDO — sem credencial, sessão nem corpo enviado.
 */
@Injectable()
export class AlloyalHttp {
  private readonly logger = new Logger('AlloyalClient');

  constructor(private readonly credenciais: TenantCredentialsRegistry) {}

  /** `POST /auth/sign_in`: a sessão vem nos cabeçalhos da resposta. */
  async login(
    base: BaseOrigin,
    cpf: string,
    senha: string,
  ): Promise<SessaoAlloyal> {
    const contexto: ContextoDaChamada = { operacao: 'login', base };
    const { apiSecret } = this.credenciais.alloyal(base);

    const resposta = await this.requisitar(
      contexto,
      {
        method: 'POST',
        url: this.urlDaApi(contexto, '/auth/sign_in'),
        headers: { 'api-secret': apiSecret },
        data: { cpf, password: senha },
      },
      'ignorado',
    );

    const cabecalhos = (resposta.headers ?? {}) as Record<string, unknown>;
    const ler = (nome: string) => {
      const valor = cabecalhos[nome];
      return typeof valor === 'string' && valor ? valor : undefined;
    };
    const uid = ler('uid');
    const client = ler('client');
    const accessToken = ler('access-token');

    if (!uid || !client || !accessToken) {
      const erro = loginSemSessao(
        contexto,
        resposta.status,
        Object.keys(cabecalhos),
      );
      this.registrar(contexto, 'POST', erro);
      throw erro;
    }
    return { uid, client, accessToken };
  }

  /** Chamada em nome do usuário: sessão dele + `api-secret` da base. */
  async comSessao(
    operacao: OperacaoAlloyal,
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    caminho: string,
    esperado: CorpoEsperado,
    pedido: PedidoAlloyal = { metodo: 'GET' },
  ): Promise<unknown> {
    const contexto: ContextoDaChamada = { operacao, base };
    // Base inválida ou credencial ausente lança aqui, antes de qualquer chamada.
    const { apiSecret } = this.credenciais.alloyal(base);
    if (!sessao?.uid || !sessao?.client || !sessao?.accessToken) {
      throw sessaoAlloyalAusente(contexto);
    }

    const resposta = await this.requisitar(
      contexto,
      {
        method: pedido.metodo,
        url: this.urlDaApi(contexto, caminho),
        headers: {
          uid: sessao.uid,
          client: sessao.client,
          'access-token': sessao.accessToken,
          'api-secret': apiSecret,
        },
        params: pedido.params,
        data: pedido.corpo,
      },
      esperado,
    );
    return resposta.data;
  }

  /**
   * Chamada administrativa (`/client/v2/businesses/<cnpj>/users<sufixo>`):
   * credencial de employee + business da base.
   */
  async comoEmployee(
    operacao: OperacaoAlloyal,
    base: BaseOrigin,
    sufixo: string,
    comTenant: boolean,
    pedido: PedidoAlloyal,
  ): Promise<unknown> {
    const contexto: ContextoDaChamada = { operacao, base };
    const { businessCnpj } = this.credenciais.alloyal(base);
    const config = alloyalConfig();
    if (!config.employeeEmail || !config.employeeToken) {
      throw alloyalNaoConfigurada(
        contexto,
        'x_clientemployee_email/x_clientemployee_token',
      );
    }
    if (!config.origemAdministrativa) {
      throw alloyalNaoConfigurada(contexto, 'BASE_URL_ALLOYAL');
    }

    const resposta = await this.requisitar(
      contexto,
      {
        method: pedido.metodo,
        url: `${config.origemAdministrativa}/client/v2/businesses/${businessCnpj}/users${sufixo}`,
        headers: {
          // "Tentant-id" é o nome que a integração sempre enviou (sic).
          ...(comTenant ? { 'Tentant-id': businessCnpj } : {}),
          'X-ClientEmployee-Email': config.employeeEmail,
          'X-ClientEmployee-Token': config.employeeToken,
        },
        params: pedido.params,
        data: pedido.corpo,
      },
      'json',
    );
    return resposta.data;
  }

  private urlDaApi(contexto: ContextoDaChamada, caminho: string): string {
    const { urlDaApi } = alloyalConfig();
    if (!urlDaApi) throw alloyalNaoConfigurada(contexto, 'BASE_URL_ALLOYAL');
    return `${urlDaApi}${caminho}`;
  }

  private async requisitar(
    contexto: ContextoDaChamada,
    pedido: AxiosRequestConfig,
    esperado: CorpoEsperado,
  ): Promise<AxiosResponse<unknown>> {
    try {
      return await medirVendor(
        {
          vendor: VENDOR_ALLOYAL,
          base: contexto.base,
          operacao: contexto.operacao,
        },
        async () => {
          let resposta: AxiosResponse<unknown>;
          try {
            resposta = await axios.request<unknown>({
              ...pedido,
              timeout: alloyalConfig().timeoutMs,
              validateStatus: () => true,
            });
          } catch (falha) {
            throw erroDeFalhaAlloyal(contexto, falha);
          }

          const erro =
            erroDeStatusAlloyal(contexto, resposta.status, resposta.data) ??
            erroDeCorpoAlloyal(
              contexto,
              esperado,
              resposta.status,
              resposta.data,
            );
          if (erro) throw erro;
          return resposta;
        },
        resultadoDaMetrica,
      );
    } catch (erro) {
      this.registrar(contexto, String(pedido.method), erro, pedido.params);
      throw erro;
    }
  }

  private registrar(
    contexto: ContextoDaChamada,
    metodo: string,
    erro: unknown,
    params?: unknown,
  ): void {
    const detalhe =
      erro instanceof IntegrationError
        ? `tipo=${erro.tipo} statusVendor=${erro.statusVendor ?? '(sem resposta)'}` +
          ` | ${texto(erro.detalhes?.motivo, erro.message)}` +
          ` | resposta: ${texto(erro.detalhes?.respostaVendor, '(vazio)')}`
        : `erro inesperado: ${erro instanceof Error ? erro.message : String(erro)}`;
    // Só os NOMES dos filtros: os valores podem ter CPF ou posição do usuário.
    const filtros =
      params && typeof params === 'object'
        ? ` | filtros: ${Object.keys(params).join(',') || '(nenhum)'}`
        : '';

    this.logger.warn(
      `${baseTag(contexto.base)} Alloyal operacao=${contexto.operacao} ${metodo}${filtros} | ${detalhe}`,
    );
  }
}

function texto(valor: unknown, padrao: string): string {
  return typeof valor === 'string' && valor ? valor : padrao;
}

import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AlloyalApiController } from 'src/beneficios/controllers/alloyal-api.controller';
import { AlloyalCashbackService } from 'src/beneficios/services/alloyal-cashback.service';
import { AlloyalCatalogoService } from 'src/beneficios/services/alloyal-catalogo.service';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { AlloyalCuponsService } from 'src/beneficios/services/alloyal-cupons.service';
import { AlloyalSessaoService } from 'src/beneficios/services/alloyal-sessao.service';
import { AlloyalUsuariosService } from 'src/beneficios/services/alloyal-usuarios.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { AllExceptionsFilter } from 'src/infra/filters/all-exceptions.filter';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { REDIS_CLIENTE } from 'src/infra/redis/redis.module';
import { RedisEmMemoria } from 'src/infra/redis/testing/redis-em-memoria';
import { AlloyalHttp } from 'src/integrations/alloyal/alloyal-http';
import { AlloyalClient } from 'src/integrations/alloyal/alloyal.client';
import { AlloyalGateway } from 'src/integrations/alloyal/alloyal.gateway';
import { AlloyalHttpFalso } from 'src/integrations/alloyal/testing/alloyal-http-falso';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/**
 * Caracterização das rotas `/alloyal/*` de ponta a ponta (HTTP do app →
 * controller → services → HTTP da Alloyal de mentira), com o pipe e o filtro
 * globais de `main.ts`. Congela, rota a rota:
 *  - o status e o corpo de erro (byte a byte), seja qual for a falha;
 *  - o que o controller converte da query/path antes de chamar a Alloyal.
 *
 * Escrita contra o controller original (um `try/catch` por rota) e mantida
 * depois da quebra: só `PROVEDORES` muda (e o cache do catálogo, que não
 * existia, é esvaziado a cada teste).
 */
const redis = new RedisEmMemoria();
const PROVEDORES = [
  AlloyalSessaoService,
  AlloyalCatalogoService,
  AlloyalCashbackService,
  AlloyalUsuariosService,
  AlloyalCuponsService,
  AlloyalCategoriesCacheService,
  AlloyalHttp,
  AlloyalClient,
  { provide: AlloyalGateway, useExisting: AlloyalClient },
  TenantCredentialsRegistry,
  CacheService,
  { provide: REDIS_CLIENTE, useValue: redis.comoRedis() },
];

describe('AlloyalApiController — rotas (caracterização de ponta a ponta)', () => {
  const ENVS = {
    BASE_URL_ALLOYAL: 'https://alloyal.teste/api/v1/',
    API_SECRET_ALLOYAL: 'segredo-mp',
    ALLOYAL_BUSINESS_ID: 'business-mp',
    ALLOYAL_BUSINESS_CNPJ: '11111111000111',
    x_clientemployee_email: 'employee@teste.local',
    x_clientemployee_token: 'token-employee',
  };
  const API = 'https://alloyal.teste/api/v1';
  const EMPLOYEE = 'https://alloyal.teste/client/v2/businesses/11111111000111';
  const envOriginal = { ...process.env };

  const CPF = '11122233344';
  const sessao = {
    uid: 'uid-1',
    client: 'client-1',
    'access-token': 'token-1',
  };

  const http = new AlloyalHttpFalso();
  let app: INestApplication;
  let usuarioDoToken: Record<string, unknown>;

  beforeAll(async () => {
    Object.assign(process.env, ENVS);
    http.instalar();

    const modulo = await Test.createTestingModule({
      controllers: [AlloyalApiController],
      providers: [...PROVEDORES],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = usuarioDoToken;
          return true;
        },
      })
      .compile();

    app = modulo.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    http.restaurar();
    process.env = { ...envOriginal };
  });

  beforeEach(async () => {
    await redis.del(...redis.chaves());
    http.requisicoes.length = 0;
    http.responderSempre({ status: 200, data: [] });
    usuarioDoToken = {
      userId: 7,
      cpf: CPF,
      role: 'USER',
      baseOrigin: 'MAIS_PRIME',
    };
  });

  const cliente = () => request(app.getHttpServer() as App);

  type Rota = {
    nome: string;
    metodo: 'get' | 'post' | 'patch';
    caminho: string;
    corpo?: Record<string, unknown>;
    /** Usa a sessão do usuário na Alloyal (uid/client/access-token). */
    comSessao: boolean;
    erro: { status: number; mensagem: string };
  };

  const ROTAS: Rota[] = [
    {
      nome: 'POST login',
      metodo: 'post',
      caminho: '/alloyal/login',
      corpo: { cpf: CPF, password: 'senha' },
      comSessao: false,
      erro: { status: 401, mensagem: 'Erro ao fazer login na API Alloyal' },
    },
    {
      nome: 'GET categories',
      metodo: 'get',
      caminho: '/alloyal/categories',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao buscar categorias' },
    },
    {
      nome: 'GET categories/:id/organizations',
      metodo: 'get',
      caminho: '/alloyal/categories/7/organizations',
      comSessao: true,
      erro: {
        status: 500,
        mensagem: 'Erro ao buscar organizações da categoria',
      },
    },
    {
      nome: 'GET organizations',
      metodo: 'get',
      caminho: '/alloyal/organizations?search=pizza',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao buscar organizações' },
    },
    {
      nome: 'GET organizations/nearest',
      metodo: 'get',
      caminho: '/alloyal/organizations/nearest?lat=-22.9&lng=-43.1',
      comSessao: true,
      erro: {
        status: 500,
        mensagem: 'Erro ao buscar organizações mais próximas',
      },
    },
    {
      nome: 'GET organizations/:id/branches',
      metodo: 'get',
      caminho: '/alloyal/organizations/9/branches',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao buscar filiais da organização' },
    },
    {
      nome: 'GET organizations/highlights_nearby',
      metodo: 'get',
      caminho: '/alloyal/organizations/highlights_nearby?lat=-22.9&lng=-43.1',
      comSessao: true,
      erro: {
        status: 500,
        mensagem: 'Erro ao buscar organizações em destaque próximas',
      },
    },
    {
      nome: 'GET organizations/highlights_online',
      metodo: 'get',
      caminho: '/alloyal/organizations/highlights_online',
      comSessao: true,
      erro: {
        status: 500,
        mensagem: 'Erro ao buscar organizações online em destaque',
      },
    },
    {
      nome: 'GET promotions',
      metodo: 'get',
      caminho: '/alloyal/promotions',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao buscar promoções' },
    },
    {
      nome: 'GET cashback_records',
      metodo: 'get',
      caminho: '/alloyal/cashback_records',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao buscar transações de cashback' },
    },
    {
      nome: 'POST cashback_transfer_requests',
      metodo: 'post',
      caminho: '/alloyal/cashback_transfer_requests',
      corpo: { cpf: CPF },
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao solicitar resgate de cashback' },
    },
    {
      nome: 'POST users',
      metodo: 'post',
      caminho: '/alloyal/users',
      corpo: {
        name: 'Dono',
        cpf: CPF,
        email: 'dono@teste.local',
        password: 'x',
      },
      comSessao: false,
      erro: { status: 500, mensagem: 'Erro ao criar usuário na API Alloyal' },
    },
    {
      nome: 'PATCH users/:cpf',
      metodo: 'patch',
      caminho: `/alloyal/users/${CPF}`,
      corpo: { password: 'nova' },
      comSessao: false,
      erro: {
        status: 500,
        mensagem: 'Erro ao atualizar usuário na API Alloyal',
      },
    },
    {
      nome: 'GET users/search/:cpf',
      metodo: 'get',
      caminho: `/alloyal/users/search/${CPF}`,
      comSessao: false,
      erro: { status: 500, mensagem: 'Erro ao buscar usuário por CPF' },
    },
    {
      nome: 'GET organizations/:id/coupons',
      metodo: 'get',
      caminho: '/alloyal/organizations/5/coupons',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao buscar cupons da organização' },
    },
    {
      nome: 'GET organizations/:id/branches/:id/coupons',
      metodo: 'get',
      caminho: '/alloyal/organizations/5/branches/8/coupons',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao buscar cupons da filial' },
    },
    {
      nome: 'GET organizations/:id/coupons/:id',
      metodo: 'get',
      caminho: '/alloyal/organizations/5/coupons/6',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao buscar detalhes do cupom' },
    },
    {
      nome: 'GET organizations/:id/orders',
      metodo: 'get',
      caminho: '/alloyal/organizations/5/orders?coupon_id=6',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao resgatar cupom com código' },
    },
    {
      nome: 'GET orders',
      metodo: 'get',
      caminho: '/alloyal/orders',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao listar resgates de cupons' },
    },
    {
      nome: 'GET orders/redeem',
      metodo: 'get',
      caminho: '/alloyal/orders/redeem?coupon_id=6',
      comSessao: true,
      erro: { status: 500, mensagem: 'Erro ao resgatar cupom genérico' },
    },
  ];

  const chamar = (rota: Rota, cabecalhos: Record<string, string> = {}) => {
    const requisicao = cliente()[rota.metodo](rota.caminho).set(cabecalhos);
    return rota.corpo ? requisicao.send(rota.corpo) : requisicao;
  };

  const corpoDeErro = (rota: Rota) =>
    JSON.stringify({
      statusCode: rota.erro.status,
      message: rota.erro.mensagem,
    });

  describe.each(ROTAS)('$nome — erro fixo', (rota) => {
    const cabecalhos = rota.comSessao ? sessao : {};

    it.each([
      ['401 da Alloyal', { status: 401, data: { errors: ['sessão'] } }],
      ['404 da Alloyal', { status: 404, data: { error: 'não existe' } }],
      ['422 da Alloyal', { status: 422, data: { errors: ['recusado'] } }],
      ['500 da Alloyal', { status: 500, data: 'erro interno' }],
      ['timeout', { falha: 'timeout' as const }],
      ['sem conexão', { falha: 'rede' as const }],
    ])('%s → status e corpo fixos da rota', async (_caso, resposta) => {
      http.responderSempre(resposta);

      const resultado = await chamar(rota, cabecalhos);

      expect(resultado.status).toBe(rota.erro.status);
      expect(resultado.text).toBe(corpoDeErro(rota));
    });

    it('token sem base → mesmo erro fixo, sem chamar a Alloyal', async () => {
      usuarioDoToken = { userId: 7, cpf: CPF, role: 'USER' };

      const resultado = await chamar(rota, cabecalhos);

      expect(resultado.status).toBe(rota.erro.status);
      expect(resultado.text).toBe(corpoDeErro(rota));
      expect(http.requisicoes).toEqual([]);
    });

    if (rota.comSessao) {
      it.each([
        ['nenhum', {}],
        ['sem access-token', { uid: 'uid-1', client: 'client-1' }],
        ['sem uid', { client: 'client-1', 'access-token': 'token-1' }],
      ])(
        'cabeçalhos de sessão: %s → mesmo erro fixo, sem chamar a Alloyal',
        async (_caso, incompletos) => {
          const resultado = await chamar(rota, incompletos);

          expect(resultado.status).toBe(rota.erro.status);
          expect(resultado.text).toBe(corpoDeErro(rota));
          expect(http.requisicoes).toEqual([]);
        },
      );
    }
  });

  describe('sucesso — o que o controller converte e repassa', () => {
    it('POST login → 201 com uid/client/accessToken', async () => {
      http.responder({
        data: {},
        headers: { uid: 'u@x', client: 'cli', 'access-token': 'tok' },
      });

      const resultado = await cliente()
        .post('/alloyal/login')
        .send({ cpf: CPF, password: 'senha' })
        .expect(201);

      expect(resultado.body).toEqual({
        uid: 'u@x',
        client: 'cli',
        accessToken: 'tok',
      });
      expect(http.ultima).toMatchObject({
        metodo: 'POST',
        url: `${API}/auth/sign_in`,
        corpo: { cpf: CPF, password: 'senha' },
      });
    });

    it('POST login sem cpf → 400 do pipe de validação (não é o erro fixo)', async () => {
      const resultado = await cliente()
        .post('/alloyal/login')
        .send({ password: 'senha' })
        .expect(400);

      expect(resultado.body).toMatchObject({ statusCode: 400 });
      expect(http.requisicoes).toEqual([]);
    });

    it('GET test-login → 200 com a mensagem de orientação', async () => {
      const resultado = await cliente().get('/alloyal/test-login').expect(200);

      expect(resultado.body).toEqual({
        message: 'Use POST /alloyal/login para autenticar com cpf e password.',
      });
    });

    it('GET categories → repassa a lista', async () => {
      const categorias = [{ id: 1, title: 'Alimentação' }];
      http.responder({ data: categorias });

      const resultado = await cliente()
        .get('/alloyal/categories')
        .set(sessao)
        .expect(200);

      expect(resultado.body).toEqual(categorias);
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        url: `${API}/categories`,
        cabecalhos: { ...sessao, 'api-secret': 'segredo-mp' },
      });
    });

    it('GET categories/:id/organizations → página numérica, coordenadas como vieram', async () => {
      await cliente()
        .get('/alloyal/categories/7/organizations?page=2&lat=-22.9&lng=-43.1')
        .set(sessao)
        .expect(200);

      expect(http.ultima).toMatchObject({
        url: `${API}/categories/7/organizations`,
        params: { page: 2, lat: '-22.9', lng: '-43.1' },
      });
    });

    it('GET organizations → página e categoria numéricas', async () => {
      await cliente()
        .get(
          '/alloyal/organizations?page=3&lat=-22.9&lng=-43.1&organization_type=online&search=pizza&category_id=5',
        )
        .set(sessao)
        .expect(200);

      expect(http.ultima).toMatchObject({
        url: `${API}/organizations`,
        params: {
          page: 3,
          lat: '-22.9',
          lng: '-43.1',
          organization_type: 'online',
          search: 'pizza',
          category_id: 5,
        },
      });
    });

    it('GET organizations/nearest, highlights_nearby e highlights_online', async () => {
      await cliente()
        .get('/alloyal/organizations/nearest?lat=-22.9&lng=-43.1')
        .set(sessao)
        .expect(200);
      expect(http.ultima).toMatchObject({
        url: `${API}/organizations/nearest`,
        params: { lat: '-22.9', lng: '-43.1' },
      });

      await cliente()
        .get('/alloyal/organizations/highlights_nearby?lat=-22.9&lng=-43.1')
        .set(sessao)
        .expect(200);
      expect(http.ultima).toMatchObject({
        url: `${API}/organizations/highlights_nearby`,
        params: { lat: '-22.9', lng: '-43.1' },
      });

      await cliente()
        .get('/alloyal/organizations/highlights_online')
        .set(sessao)
        .expect(200);
      expect(http.ultima.url).toBe(`${API}/organizations/highlights_online`);
    });

    it('GET organizations/:id/branches → id no caminho', async () => {
      await cliente()
        .get('/alloyal/organizations/9/branches?lat=-22.9&lng=-43.1')
        .set(sessao)
        .expect(200);

      expect(http.ultima).toMatchObject({
        url: `${API}/organizations/9/branches`,
        params: { lat: '-22.9', lng: '-43.1' },
      });
    });

    it('GET promotions → números convertidos e distância limitada a 30', async () => {
      await cliente()
        .get(
          '/alloyal/promotions?page=2&redeem_type=online&category_id=5&organization_id=3&distance_km=80&term=pizza',
        )
        .set(sessao)
        .expect(200);

      expect(http.ultima).toMatchObject({
        url: `${API}/promotions`,
        params: {
          page: 2,
          redeem_type: 'online',
          category_id: 5,
          organization_id: 3,
          distance_km: 30,
          term: 'pizza',
        },
      });
    });

    it('GET cashback_records → resumo normalizado', async () => {
      http.responder({ data: { total_amount: '10', cashback_records: [] } });

      const resultado = await cliente()
        .get('/alloyal/cashback_records')
        .set(sessao)
        .expect(200);

      expect(resultado.body).toMatchObject({
        total_amount: 10,
        available_amount: 0,
        cashback_records: [],
      });
      expect(http.ultima.url).toBe(`${API}/cashback_records`);
    });

    it('POST cashback_transfer_requests → 201 sem corpo; registra o que chega à Alloyal', async () => {
      http.responder({ status: 201, data: { id: 1 } });

      const resultado = await cliente()
        .post('/alloyal/cashback_transfer_requests')
        .set(sessao)
        .send({ cpf: CPF })
        .expect(201);

      expect(resultado.text).toBe('');
      expect(http.ultima).toMatchObject({
        metodo: 'POST',
        url: `${API}/cashback_transfer_requests`,
      });
      // Comportamento vigente: o DTO não tem decorators de validação, e o
      // `whitelist` do pipe global remove o `cpf` antes de chegar ao service.
      expect(http.ultima.corpo).toEqual({});
    });

    it('rotas de usuário → business da base e credencial de employee', async () => {
      http.responderSempre({ data: [{ id: 900, cpf: CPF }] });
      await cliente().get(`/alloyal/users/search/${CPF}`).expect(200);
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        url: `${EMPLOYEE}/users`,
        params: { page: 1, active: true, term: CPF },
      });

      http.responderSempre({ data: { id: 900, cpf: CPF, active: true } });
      await cliente()
        .post('/alloyal/users')
        .send({
          name: 'Dono',
          cpf: CPF,
          email: 'dono@teste.local',
          password: 'x',
        })
        .expect(201);
      expect(http.ultima).toMatchObject({
        metodo: 'POST',
        url: `${EMPLOYEE}/users`,
        corpo: { cpf: CPF, user_tags: 'APP-ASSOCIADO' },
      });

      await cliente()
        .patch(`/alloyal/users/${CPF}`)
        .send({ password: 'nova' })
        .expect(200);
      expect(http.ultima).toMatchObject({
        metodo: 'PATCH',
        url: `${EMPLOYEE}/users/${CPF}`,
        corpo: { password: 'nova' },
      });
    });

    it('rotas de usuário → CPF de terceiro responde 403 (não o erro fixo) e não chama a Alloyal', async () => {
      const corpo403 = JSON.stringify({
        message: 'Você não tem permissão para acessar os dados de outra conta',
        error: 'Forbidden',
        statusCode: 403,
      });

      const busca = await cliente().get('/alloyal/users/search/55566677788');
      expect(busca.status).toBe(403);
      expect(busca.text).toBe(corpo403);

      const criacao = await cliente().post('/alloyal/users').send({
        name: 'Outro',
        cpf: '55566677788',
        email: 'outro@teste.local',
        password: 'x',
      });
      expect(criacao.status).toBe(403);
      expect(criacao.text).toBe(corpo403);

      expect(http.requisicoes).toEqual([]);
    });

    it('PATCH users/:id de terceiro → consulta os usuários do próprio CPF e responde 403', async () => {
      http.responderSempre({ data: [{ id: 900, cpf: CPF }] });

      const resultado = await cliente()
        .patch('/alloyal/users/901')
        .send({ password: 'nova' });

      expect(resultado.status).toBe(403);
      expect(http.requisicoes).toHaveLength(1);
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        params: { term: CPF },
      });
    });

    it('PATCH users/:id sem base no token e id de terceiro → erro fixo 500 (a consulta de posse exige a base)', async () => {
      usuarioDoToken = { userId: 7, cpf: CPF, role: 'USER' };

      const resultado = await cliente()
        .patch('/alloyal/users/901')
        .send({ password: 'nova' });

      expect(resultado.status).toBe(500);
      expect(resultado.text).toBe(
        JSON.stringify({
          statusCode: 500,
          message: 'Erro ao atualizar usuário na API Alloyal',
        }),
      );
      expect(http.requisicoes).toEqual([]);
    });

    it('cupons → ids no caminho, tipo de uso e página', async () => {
      await cliente()
        .get('/alloyal/organizations/5/coupons?usage_type=presencial')
        .set(sessao)
        .expect(200);
      expect(http.ultima).toMatchObject({
        url: `${API}/organizations/5/coupons`,
        params: { usage_type: 'presencial' },
      });

      await cliente()
        .get('/alloyal/organizations/5/coupons')
        .set(sessao)
        .expect(200);
      expect(http.ultima.params).toEqual({ usage_type: 'online' });

      await cliente()
        .get('/alloyal/organizations/5/branches/8/coupons?page=2')
        .set(sessao)
        .expect(200);
      expect(http.ultima).toMatchObject({
        url: `${API}/organizations/5/branches/8/coupons`,
        params: { page: 2 },
      });

      http.responder({ data: { id: 6, title: 'Cupom' } });
      const detalhe = await cliente()
        .get('/alloyal/organizations/5/coupons/6')
        .set(sessao)
        .expect(200);
      expect(detalhe.body).toMatchObject({ id: 6, title: 'Cupom' });
      expect(http.ultima.url).toBe(`${API}/organizations/5/coupons/6`);
    });

    it('pedidos → resgate com código (GET), listagem e resgate genérico (POST na Alloyal)', async () => {
      const pedido = { id: 1, number: 'N1' };
      http.responderSempre({ data: pedido });

      const comCodigo = await cliente()
        .get('/alloyal/organizations/5/orders?coupon_id=6')
        .set(sessao)
        .expect(200);
      expect(comCodigo.body).toEqual(pedido);
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        url: `${API}/organizations/5/orders`,
        params: { coupon_id: 6 },
      });

      await cliente().get('/alloyal/orders').set(sessao).expect(200);
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        url: `${API}/orders`,
      });

      const generico = await cliente()
        .get('/alloyal/orders/redeem?coupon_id=6')
        .set(sessao)
        .expect(200);
      expect(generico.body).toEqual(pedido);
      expect(http.ultima).toMatchObject({
        metodo: 'POST',
        url: `${API}/orders`,
        corpo: { coupon_id: 6 },
      });
    });
  });
});

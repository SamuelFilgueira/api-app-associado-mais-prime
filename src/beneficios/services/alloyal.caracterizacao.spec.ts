import { AlloyalCashbackService } from 'src/beneficios/services/alloyal-cashback.service';
import { AlloyalCatalogoService } from 'src/beneficios/services/alloyal-catalogo.service';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { AlloyalCuponsService } from 'src/beneficios/services/alloyal-cupons.service';
import { AlloyalSessaoService } from 'src/beneficios/services/alloyal-sessao.service';
import { AlloyalUsuariosService } from 'src/beneficios/services/alloyal-usuarios.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { RedisEmMemoria } from 'src/infra/redis/testing/redis-em-memoria';
import { AlloyalHttp } from 'src/integrations/alloyal/alloyal-http';
import { AlloyalClient } from 'src/integrations/alloyal/alloyal.client';
import { AlloyalHttpFalso } from 'src/integrations/alloyal/testing/alloyal-http-falso';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

/**
 * Caracterização do módulo Alloyal: para cada operação, o que sai para a
 * Alloyal (método, URL, parâmetros, cabeçalhos, corpo, prazo) e o que volta
 * para o app. Escrita contra o `AlloyalApiService` original (1.165 linhas) e
 * mantida depois da quebra: só `montar()` muda.
 *
 * `montar()` expõe as operações com os nomes e as assinaturas do service
 * original, sobre a pilha atual (services por assunto → `AlloyalClient` →
 * HTTP de mentira). Os números voltam a ser texto porque essa conversão,
 * que era do controller, hoje é do domínio.
 */
type Sessao = { uid: string; client: string; accessToken: string };

function montar() {
  const client = new AlloyalClient(
    new AlloyalHttp(new TenantCredentialsRegistry()),
  );
  const cache = new CacheService(new RedisEmMemoria().comoRedis());
  const sessoes = new AlloyalSessaoService(client);
  const catalogo = new AlloyalCatalogoService(
    client,
    cache,
    new AlloyalCategoriesCacheService(cache),
  );
  const cashback = new AlloyalCashbackService(client);
  const usuarios = new AlloyalUsuariosService(client);
  const cupons = new AlloyalCuponsService(client);

  const texto = (n?: number) => (n === undefined ? undefined : String(n));
  // A posse (403) era do controller e tem spec próprio; aqui, um ADMIN.
  const admin = (base: string) => ({
    usuario: { userId: 1, role: 'ADMIN' },
    base,
  });

  return {
    login: (base: string, cpf: string, senha: string) =>
      sessoes.login(base, cpf, senha),
    getCategories: (base: string, sessao: Sessao) =>
      catalogo.categorias(base, sessao),
    getOrganizationsByCategory: (
      base: string,
      id: string,
      page?: number,
      lat?: string,
      lng?: string,
      sessao?: Sessao,
    ) =>
      catalogo.organizacoesDaCategoria(base, sessao as Sessao, id, {
        page: texto(page),
        lat,
        lng,
      }),
    getOrganizations: (
      base: string,
      page?: number,
      lat?: string,
      lng?: string,
      organization_type?: string,
      search?: string,
      category_id?: number,
      sessao?: Sessao,
    ) =>
      catalogo.organizacoes(base, sessao as Sessao, {
        page: texto(page),
        lat,
        lng,
        organization_type,
        search,
        category_id: texto(category_id),
      }),
    getNearestOrganizations: (
      base: string,
      lat?: string,
      lng?: string,
      sessao?: Sessao,
    ) => catalogo.organizacoesProximas(base, sessao as Sessao, { lat, lng }),
    getHighlightsNearby: (
      base: string,
      lat?: string,
      lng?: string,
      sessao?: Sessao,
    ) => catalogo.destaquesProximos(base, sessao as Sessao, { lat, lng }),
    getHighlightsOnline: (base: string, sessao: Sessao) =>
      catalogo.destaquesOnline(base, sessao),
    getBranchesByOrganization: (
      base: string,
      organization_id: number,
      lat?: string,
      lng?: string,
      sessao?: Sessao,
    ) =>
      catalogo.filiais(base, sessao as Sessao, String(organization_id), {
        lat,
        lng,
      }),
    getPromotions: (
      base: string,
      page?: number,
      lat?: string,
      lng?: string,
      redeem_type?: string,
      category_id?: number,
      organization_id?: number,
      distance_km?: number,
      term?: string,
      sessao?: Sessao,
    ) =>
      catalogo.promocoes(base, sessao as Sessao, {
        page: texto(page),
        lat,
        lng,
        redeem_type,
        category_id: texto(category_id),
        organization_id: texto(organization_id),
        distance_km: texto(distance_km),
        term,
      }),
    getCashbackRecords: (base: string, sessao: Sessao) =>
      cashback.extrato(base, sessao),
    requestCashbackTransfer: (
      base: string,
      dto: { cpf: string },
      sessao: Sessao,
    ) => cashback.solicitarResgate(base, sessao, dto),
    searchUserByCpf: (base: string, cpf: string) =>
      usuarios.buscarPorCpf(admin(base), cpf),
    createUser: (
      base: string,
      dto: { name: string; cpf: string; email: string; password: string },
    ) => usuarios.criar(admin(base), dto),
    updateUser: (base: string, cpf: string, dto: Record<string, unknown>) =>
      usuarios.atualizar(admin(base), cpf, dto),
    getOrganizationCoupons: (
      base: string,
      organization_id: number,
      usage_type?: string,
      sessao?: Sessao,
    ) =>
      cupons.cuponsDaOrganizacao(
        base,
        sessao as Sessao,
        String(organization_id),
        usage_type,
      ),
    getBranchCoupons: (
      base: string,
      organization_id: number,
      branch_id: number,
      page?: number,
      sessao?: Sessao,
    ) =>
      cupons.cuponsDaFilial(
        base,
        sessao as Sessao,
        String(organization_id),
        String(branch_id),
        texto(page),
      ),
    getCouponDetail: (
      base: string,
      organization_id: number,
      coupon_id: number,
      sessao?: Sessao,
    ) =>
      cupons.detalheDoCupom(
        base,
        sessao as Sessao,
        String(organization_id),
        String(coupon_id),
      ),
    redeemCouponWithCode: (
      base: string,
      organization_id: number,
      dto: { coupon_id: number },
      sessao: Sessao,
    ) =>
      cupons.resgatarComCodigo(
        base,
        sessao,
        String(organization_id),
        String(dto.coupon_id),
      ),
    listAllCouponOrders: (base: string, sessao: Sessao) =>
      cupons.pedidos(base, sessao),
    redeemCouponGeneric: (
      base: string,
      dto: { coupon_id: number },
      sessao: Sessao,
    ) => cupons.resgatar(base, sessao, String(dto.coupon_id)),
  };
}

describe('Alloyal — caracterização (o que cada operação envia e devolve)', () => {
  const ENVS = {
    BASE_URL_ALLOYAL: 'https://alloyal.teste/api/v1/',
    API_SECRET_ALLOYAL: 'segredo-mp',
    ALLOYAL_BUSINESS_ID: 'business-mp',
    ALLOYAL_BUSINESS_CNPJ: '11111111000111',
    API_SECRET_ALLOYAL_RS: 'segredo-rs',
    ALLOYAL_BUSINESS_ID_RS: 'business-rs',
    ALLOYAL_BUSINESS_CNPJ_RS: '22222222000122',
    x_clientemployee_email: 'employee@teste.local',
    x_clientemployee_token: 'token-employee',
  };
  const API = 'https://alloyal.teste/api/v1';
  const EMPLOYEE = 'https://alloyal.teste/client/v2/businesses';
  const envOriginal = { ...process.env };

  const sessao: Sessao = {
    uid: 'uid-1',
    client: 'client-1',
    accessToken: 'token-1',
  };
  const cabecalhosDaSessao = {
    uid: 'uid-1',
    client: 'client-1',
    'access-token': 'token-1',
    'api-secret': 'segredo-mp',
  };
  const cabecalhosDeEmployee = {
    'x-clientemployee-email': 'employee@teste.local',
    'x-clientemployee-token': 'token-employee',
  };

  const http = new AlloyalHttpFalso();
  let alloyal: ReturnType<typeof montar>;

  beforeAll(() => {
    // As datas saem no fuso do processo (`main.ts` fixa America/Sao_Paulo).
    process.env.TZ = 'America/Sao_Paulo';
  });

  beforeEach(() => {
    Object.assign(process.env, ENVS, { TZ: 'America/Sao_Paulo' });
    http.instalar();
    alloyal = montar();
  });

  afterEach(() => {
    http.restaurar();
    process.env = { ...envOriginal, TZ: 'America/Sao_Paulo' };
  });

  afterAll(() => {
    process.env = { ...envOriginal };
  });

  const organizacaoBruta = {
    id: 10,
    name: 'Loja',
    cover_picture: 'capa.png',
    background_picture: 'fundo.png',
    best_discount_percent: 15,
    category_name: 'Alimentação',
    instagram_url: 'insta',
    facebook_url: 'face',
    twitter_url: 'tw',
    cashback_percent: 2,
    cashback_text: '2% de volta',
    discount_text: '15% off',
    description: 'Descrição',
    distance_km: 1.23456,
    favorited: true,
    campo_extra: 'não sai',
  };
  const organizacaoMapeada = {
    id: 10,
    name: 'Loja',
    cover_picture: 'capa.png',
    background_picture: 'fundo.png',
    best_discount_percent: 15,
    category_name: 'Alimentação',
    instagram_url: 'insta',
    facebook_url: 'face',
    twitter_url: 'tw',
    cashback_percent: 2,
    cashback_text: '2% de volta',
    discount_text: '15% off',
    description: 'Descrição',
  };

  describe('sessão', () => {
    it('login: POST /auth/sign_in com o api-secret da base; devolve a sessão dos cabeçalhos da resposta', async () => {
      http.responder({
        data: { data: { id: 1 } },
        headers: { uid: 'u@x', client: 'cli', 'access-token': 'tok' },
      });

      await expect(
        alloyal.login('MAIS_PRIME_RS', '12345678900', 'senha'),
      ).resolves.toEqual({ uid: 'u@x', client: 'cli', accessToken: 'tok' });

      expect(http.requisicoes).toEqual([
        {
          metodo: 'POST',
          url: `${API}/auth/sign_in`,
          cabecalhos: { 'api-secret': 'segredo-rs' },
          corpo: { cpf: '12345678900', password: 'senha' },
          timeout: 20_000,
        },
      ]);
    });

    it('login: resposta sem os cabeçalhos de sessão → rejeita', async () => {
      http.responder({ data: {}, headers: { uid: 'u@x' } });

      await expect(
        alloyal.login('MAIS_PRIME', '12345678900', 'senha'),
      ).rejects.toBeDefined();
    });

    it('login: 401 da Alloyal → rejeita', async () => {
      http.responder({ status: 401, data: { errors: ['inválido'] } });

      await expect(
        alloyal.login('MAIS_PRIME', '12345678900', 'errada'),
      ).rejects.toBeDefined();
    });
  });

  describe('catálogo', () => {
    it('getCategories: GET /categories com a sessão do usuário + api-secret; devolve o corpo como veio', async () => {
      const categorias = [{ id: 1, title: 'Alimentação', subcategories: [] }];
      http.responder({ data: categorias });

      await expect(
        alloyal.getCategories('MAIS_PRIME', sessao),
      ).resolves.toEqual(categorias);
      expect(http.requisicoes).toEqual([
        {
          metodo: 'GET',
          url: `${API}/categories`,
          cabecalhos: cabecalhosDaSessao,
          timeout: 20_000,
        },
      ]);
    });

    it('getOrganizationsByCategory: tira as imagens grandes e as redes sociais, arredonda a distância e mantém o resto', async () => {
      http.responder({
        data: [
          {
            id: 1,
            name: 'A',
            favorited: true,
            logo_image_small: 'p.png',
            distance_km: 1.23456,
            instagram_url: 'i',
            facebook_url: 'f',
            twitter_url: 't',
            top_background_image_large: 'x',
            top_background_image_v2_large: 'x',
            banner_image_large: 'x',
            banner_image_v2_large: 'x',
          },
          { id: 2, name: 'B' },
        ],
      });

      await expect(
        alloyal.getOrganizationsByCategory(
          'MAIS_PRIME',
          '7',
          2,
          '-22.9',
          '-43.1',
          sessao,
        ),
      ).resolves.toEqual([
        {
          id: 1,
          name: 'A',
          favorited: true,
          logo_image_small: 'p.png',
          distance_km: 1.23,
        },
        { id: 2, name: 'B', distance_km: 0 },
      ]);
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/categories/7/organizations`,
        params: { page: 2, lat: '-22.9', lng: '-43.1' },
        cabecalhos: cabecalhosDaSessao,
        timeout: 20_000,
      });
    });

    it('getOrganizationsByCategory: sem coordenadas manda só a página (1 por padrão)', async () => {
      await alloyal.getOrganizationsByCategory(
        'MAIS_PRIME',
        '7',
        undefined,
        undefined,
        undefined,
        sessao,
      );

      expect(http.ultima.params).toEqual({ page: 1 });
    });

    it('getOrganizations: manda só os filtros informados e devolve os 14 campos', async () => {
      http.responder({ data: [organizacaoBruta, { id: 11 }] });

      const lista = await alloyal.getOrganizations(
        'MAIS_PRIME',
        3,
        '-22.9',
        '-43.1',
        'online',
        'pizza',
        5,
        sessao,
      );

      expect(lista).toEqual([
        { ...organizacaoMapeada, distance_km: 1.23 },
        {
          id: 11,
          name: undefined,
          cover_picture: undefined,
          background_picture: undefined,
          best_discount_percent: undefined,
          category_name: undefined,
          instagram_url: undefined,
          facebook_url: undefined,
          twitter_url: undefined,
          cashback_percent: undefined,
          cashback_text: undefined,
          discount_text: undefined,
          description: undefined,
          distance_km: 0,
        },
      ]);
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/organizations`,
        params: {
          page: 3,
          lat: '-22.9',
          lng: '-43.1',
          organization_type: 'online',
          search: 'pizza',
          category_id: 5,
        },
        cabecalhos: cabecalhosDaSessao,
        timeout: 20_000,
      });
    });

    it('getOrganizations: sem filtros manda só a página', async () => {
      await alloyal.getOrganizations(
        'MAIS_PRIME',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sessao,
      );

      expect(http.ultima.params).toEqual({ page: 1 });
    });

    it('getNearestOrganizations e getHighlightsNearby: coordenadas na query, organização com distância', async () => {
      http.responderSempre({ data: [organizacaoBruta] });

      await expect(
        alloyal.getNearestOrganizations('MAIS_PRIME', '-22.9', '-43.1', sessao),
      ).resolves.toEqual([{ ...organizacaoMapeada, distance_km: 1.23 }]);
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        url: `${API}/organizations/nearest`,
        params: { lat: '-22.9', lng: '-43.1' },
        cabecalhos: cabecalhosDaSessao,
      });

      await expect(
        alloyal.getHighlightsNearby('MAIS_PRIME', undefined, undefined, sessao),
      ).resolves.toEqual([{ ...organizacaoMapeada, distance_km: 1.23 }]);
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        url: `${API}/organizations/highlights_nearby`,
        params: {},
      });
    });

    it('getHighlightsOnline: organização sem o campo de distância', async () => {
      http.responder({ data: [organizacaoBruta] });

      const lista = await alloyal.getHighlightsOnline('MAIS_PRIME', sessao);

      expect(lista).toEqual([organizacaoMapeada]);
      expect(lista[0]).not.toHaveProperty('distance_km');
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/organizations/highlights_online`,
        cabecalhos: cabecalhosDaSessao,
        timeout: 20_000,
      });
    });

    it('getBranchesByOrganization: horários em HH:mm e distância arredondada', async () => {
      http.responder({
        data: [
          {
            id: 1,
            name: 'Filial Centro',
            taxpayer_number: '11222333000144',
            telephone: '2133334444',
            full_address: 'Rua A, 1',
            zipcode: '20000000',
            lat: -22.9,
            lng: -43.1,
            opening_time: '2000-01-01T12:00:00.000Z',
            closing_time: '2000-01-01T21:30:00.000Z',
            distance_km: 0.456,
            extra: 'não sai',
          },
          { id: 2 },
        ],
      });

      await expect(
        alloyal.getBranchesByOrganization(
          'MAIS_PRIME',
          9,
          '-22.9',
          '-43.1',
          sessao,
        ),
      ).resolves.toEqual([
        {
          id: 1,
          name: 'Filial Centro',
          taxpayer_number: '11222333000144',
          telephone: '2133334444',
          full_address: 'Rua A, 1',
          zipcode: '20000000',
          lat: -22.9,
          lng: -43.1,
          opening_time: '10:00',
          closing_time: '19:30',
          distance_km: 0.46,
        },
        {
          id: 2,
          name: undefined,
          taxpayer_number: undefined,
          telephone: undefined,
          full_address: undefined,
          zipcode: undefined,
          lat: undefined,
          lng: undefined,
          opening_time: '',
          closing_time: '',
          distance_km: 0,
        },
      ]);
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        url: `${API}/organizations/9/branches`,
        params: { lat: '-22.9', lng: '-43.1' },
      });
    });

    it('getPromotions: limita a distância a 30 km e normaliza datas, dias e tags', async () => {
      http.responder({
        data: [
          {
            id: 1,
            title: 'Promo',
            rules: 'regras',
            description: 'desc',
            url: null,
            discount: 10,
            start_date: '2026-11-25T15:30:00.000Z',
            end_date: '2026-12-25T02:00:00.000Z',
            working_days: [
              {
                week_day: 1,
                is_available: true,
                start_hour: '08:00',
                end_hour: '18:00',
                extra: 'não sai',
              },
            ],
            quantity: 5,
            redeemed_count: 1,
            infinity: false,
            organization_id: 3,
            dynamic_voucher: false,
            branch_id: 4,
            coupon_id: 6,
            tags: ['a'],
            extra: 'não sai',
          },
          { id: 2, working_days: null, tags: null },
        ],
      });

      await expect(
        alloyal.getPromotions(
          'MAIS_PRIME',
          2,
          '-22.9',
          '-43.1',
          'online',
          5,
          3,
          80,
          'pizza',
          sessao,
        ),
      ).resolves.toEqual([
        {
          id: 1,
          title: 'Promo',
          rules: 'regras',
          description: 'desc',
          url: null,
          discount: 10,
          start_date: '25/11/2026, 12:30:00',
          end_date: '24/12/2026, 23:00:00',
          working_days: [
            {
              week_day: 1,
              is_available: true,
              start_hour: '08:00',
              end_hour: '18:00',
            },
          ],
          quantity: 5,
          redeemed_count: 1,
          infinity: false,
          organization_id: 3,
          dynamic_voucher: false,
          branch_id: 4,
          coupon_id: 6,
          tags: ['a'],
        },
        {
          id: 2,
          title: undefined,
          rules: undefined,
          description: undefined,
          url: undefined,
          discount: undefined,
          start_date: '',
          end_date: '',
          working_days: [],
          quantity: undefined,
          redeemed_count: undefined,
          infinity: undefined,
          organization_id: undefined,
          dynamic_voucher: undefined,
          branch_id: undefined,
          coupon_id: undefined,
          tags: [],
        },
      ]);
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/promotions`,
        params: {
          lat: '-22.9',
          lng: '-43.1',
          page: 2,
          redeem_type: 'online',
          category_id: 5,
          organization_id: 3,
          distance_km: 30,
          term: 'pizza',
        },
        cabecalhos: cabecalhosDaSessao,
        timeout: 20_000,
      });
    });

    it('getPromotions: sem filtros não manda parâmetro nenhum', async () => {
      await alloyal.getPromotions(
        'MAIS_PRIME',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sessao,
      );

      expect(http.ultima.params).toEqual({});
    });

    it('lista que não veio como lista → rejeita', async () => {
      http.responderSempre({ data: { erro: 'inesperado' } });

      await expect(
        alloyal.getOrganizations(
          'MAIS_PRIME',
          1,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          sessao,
        ),
      ).rejects.toBeDefined();
      await expect(
        alloyal.getHighlightsOnline('MAIS_PRIME', sessao),
      ).rejects.toBeDefined();
    });

    it('sem sessão completa → rejeita sem chamar a Alloyal', async () => {
      await expect(
        alloyal.getCategories('MAIS_PRIME', { ...sessao, accessToken: '' }),
      ).rejects.toBeDefined();
      await expect(
        alloyal.getOrganizations('MAIS_PRIME', 1),
      ).rejects.toBeDefined();

      expect(http.requisicoes).toEqual([]);
    });
  });

  describe('cashback', () => {
    it('getCashbackRecords: converte os valores para número e preenche o que faltar', async () => {
      http.responder({
        data: {
          total_amount: '12.5',
          pending_amount: 1,
          available_amount: null,
          title: 'Seu cashback',
          cashback_records: [{ id: 1, amount: 2 }],
          extra: 'não sai',
        },
      });

      await expect(
        alloyal.getCashbackRecords('MAIS_PRIME', sessao),
      ).resolves.toEqual({
        total_amount: 12.5,
        pending_amount: 1,
        approved_amount: 0,
        available_amount: 0,
        in_transfer_amount: 0,
        transferred_amount: 0,
        title: 'Seu cashback',
        subtitle: '',
        status: '',
        cashback_records: [{ id: 1, amount: 2 }],
      });
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/cashback_records`,
        cabecalhos: cabecalhosDaSessao,
        timeout: 20_000,
      });
    });

    it('getCashbackRecords: corpo vazio → tudo zerado', async () => {
      http.responder({ data: null });

      await expect(
        alloyal.getCashbackRecords('MAIS_PRIME', sessao),
      ).resolves.toEqual({
        total_amount: 0,
        pending_amount: 0,
        approved_amount: 0,
        available_amount: 0,
        in_transfer_amount: 0,
        transferred_amount: 0,
        title: '',
        subtitle: '',
        status: '',
        cashback_records: [],
      });
    });

    it('requestCashbackTransfer: POST /cashback_transfer_requests com o corpo recebido; não devolve nada', async () => {
      http.responder({ status: 201, data: { id: 99 } });

      await expect(
        alloyal.requestCashbackTransfer(
          'MAIS_PRIME',
          { cpf: '12345678900' },
          sessao,
        ),
      ).resolves.toBeUndefined();
      expect(http.requisicoes).toEqual([
        {
          metodo: 'POST',
          url: `${API}/cashback_transfer_requests`,
          cabecalhos: cabecalhosDaSessao,
          corpo: { cpf: '12345678900' },
          timeout: 20_000,
        },
      ]);
    });

    it('requestCashbackTransfer: recusa da Alloyal (422) → rejeita', async () => {
      http.responder({ status: 422, data: { errors: ['sem saldo'] } });

      await expect(
        alloyal.requestCashbackTransfer(
          'MAIS_PRIME',
          { cpf: '12345678900' },
          sessao,
        ),
      ).rejects.toBeDefined();
    });
  });

  describe('usuários (credencial de employee)', () => {
    it('searchUserByCpf: GET no business da base, só dígitos no termo; devolve a lista', async () => {
      const usuarios = [{ id: 900, cpf: '12345678900', active: true }];
      http.responder({ data: usuarios });

      await expect(
        alloyal.searchUserByCpf('MAIS_PRIME_RS', '123.456.789-00'),
      ).resolves.toEqual(usuarios);
      expect(http.requisicoes).toEqual([
        {
          metodo: 'GET',
          url: `${EMPLOYEE}/22222222000122/users`,
          params: { page: 1, active: true, term: '12345678900' },
          cabecalhos: cabecalhosDeEmployee,
          timeout: 20_000,
        },
      ]);
    });

    it('searchUserByCpf: corpo que não é lista → lista vazia', async () => {
      http.responder({ data: { users: [] } });

      await expect(
        alloyal.searchUserByCpf('MAIS_PRIME', '12345678900'),
      ).resolves.toEqual([]);
    });

    it('createUser: POST com a tag APP-ASSOCIADO; devolve o usuário criado', async () => {
      const criado = { id: 901, cpf: '12345678900', active: true };
      http.responder({ status: 201, data: criado });

      await expect(
        alloyal.createUser('MAIS_PRIME', {
          name: 'Fulano',
          cpf: '12345678900',
          email: 'fulano@teste.local',
          password: 'x',
        }),
      ).resolves.toEqual(criado);
      expect(http.requisicoes).toEqual([
        {
          metodo: 'POST',
          url: `${EMPLOYEE}/11111111000111/users`,
          cabecalhos: {
            'tentant-id': '11111111000111',
            ...cabecalhosDeEmployee,
          },
          corpo: {
            name: 'Fulano',
            cpf: '12345678900',
            email: 'fulano@teste.local',
            password: 'x',
            user_tags: 'APP-ASSOCIADO',
          },
          timeout: 20_000,
        },
      ]);
    });

    it('createUser: usuário que já existia desativado é reativado com os dados novos (mesma base)', async () => {
      const reativado = { id: 9, cpf: '12345678900', active: true };
      http.responder({ data: { id: 9, active: false } }, { data: reativado });

      await expect(
        alloyal.createUser('MAIS_PRIME_RS', {
          name: 'Fulano',
          cpf: '123.456.789-00',
          email: 'fulano@teste.local',
          password: 'x',
        }),
      ).resolves.toEqual(reativado);
      expect(http.requisicoes).toHaveLength(2);
      expect(http.requisicoes[1]).toEqual({
        metodo: 'PATCH',
        url: `${EMPLOYEE}/22222222000122/users/12345678900`,
        cabecalhos: {
          'tentant-id': '22222222000122',
          ...cabecalhosDeEmployee,
        },
        corpo: {
          name: 'Fulano',
          email: 'fulano@teste.local',
          password: 'x',
          active: true,
          user_tags: ['APP-ASSOCIADO'],
        },
        timeout: 20_000,
      });
    });

    it('updateUser: PATCH no identificador (só dígitos) com o corpo recebido', async () => {
      const atualizado = { id: 900, name: 'Novo' };
      http.responder({ data: atualizado });

      await expect(
        alloyal.updateUser('MAIS_PRIME', '900', { password: 'nova' }),
      ).resolves.toEqual(atualizado);
      expect(http.requisicoes).toEqual([
        {
          metodo: 'PATCH',
          url: `${EMPLOYEE}/11111111000111/users/900`,
          cabecalhos: {
            'tentant-id': '11111111000111',
            ...cabecalhosDeEmployee,
          },
          corpo: { password: 'nova' },
          timeout: 20_000,
        },
      ]);
    });

    it('sem a credencial de employee → rejeita sem chamar a Alloyal', async () => {
      delete process.env.x_clientemployee_token;
      alloyal = montar();

      await expect(
        alloyal.searchUserByCpf('MAIS_PRIME', '12345678900'),
      ).rejects.toBeDefined();
      await expect(
        alloyal.updateUser('MAIS_PRIME', '900', { password: 'nova' }),
      ).rejects.toBeDefined();

      expect(http.requisicoes).toEqual([]);
    });

    it('falha da Alloyal (500, timeout) → rejeita', async () => {
      http.responder({ status: 500, data: 'erro' }, { falha: 'timeout' });

      await expect(
        alloyal.searchUserByCpf('MAIS_PRIME', '12345678900'),
      ).rejects.toBeDefined();
      await expect(
        alloyal.createUser('MAIS_PRIME', {
          name: 'Fulano',
          cpf: '12345678900',
          email: 'fulano@teste.local',
          password: 'x',
        }),
      ).rejects.toBeDefined();
    });
  });

  describe('cupons e pedidos', () => {
    const cupomBruto = {
      id: 1,
      template: 'online',
      title: 'Cupom',
      description: 'desc',
      cashback_text: null,
      online_payment_text: null,
      discount: 10,
      start_date: '2026-11-25T15:30:00.000Z',
      end_date: '2026-12-25T02:00:00.000Z',
      infinity: true,
      picture_small_url: 'p.png',
      picture_large_url: 'g.png',
      organization_id: 5,
      branch_id: 8,
      extra: 'não sai',
    };

    it('getOrganizationCoupons: usage_type "online" por padrão; datas em dd/mm/aaaa', async () => {
      http.responderSempre({ data: [cupomBruto, { id: 2 }] });

      await expect(
        alloyal.getOrganizationCoupons('MAIS_PRIME', 5, undefined, sessao),
      ).resolves.toEqual([
        {
          id: 1,
          template: 'online',
          title: 'Cupom',
          description: 'desc',
          cashback_text: null,
          online_payment_text: null,
          discount: 10,
          start_date: '25/11/2026',
          end_date: '24/12/2026',
        },
        {
          id: 2,
          template: undefined,
          title: undefined,
          description: undefined,
          cashback_text: undefined,
          online_payment_text: undefined,
          discount: undefined,
          start_date: '',
          end_date: '',
        },
      ]);
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/organizations/5/coupons`,
        params: { usage_type: 'online' },
        cabecalhos: cabecalhosDaSessao,
        timeout: 20_000,
      });

      await alloyal.getOrganizationCoupons(
        'MAIS_PRIME',
        5,
        'presencial',
        sessao,
      );
      expect(http.ultima.params).toEqual({ usage_type: 'presencial' });
    });

    it('getBranchCoupons: página na query; cupom com imagens, organização e filial', async () => {
      http.responder({ data: [cupomBruto] });

      await expect(
        alloyal.getBranchCoupons('MAIS_PRIME', 5, 8, 2, sessao),
      ).resolves.toEqual([
        {
          id: 1,
          template: 'online',
          title: 'Cupom',
          description: 'desc',
          cashback_text: null,
          online_payment_text: null,
          discount: 10,
          start_date: '25/11/2026',
          end_date: '24/12/2026',
          infinity: true,
          picture_small_url: 'p.png',
          picture_large_url: 'g.png',
          organization_id: 5,
          branch_id: 8,
        },
      ]);
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/organizations/5/branches/8/coupons`,
        params: { page: 2 },
        cabecalhos: cabecalhosDaSessao,
        timeout: 20_000,
      });
    });

    it('getCouponDetail: detalhe com datas em dd/mm/aaaa e os dias como vieram', async () => {
      const dias = [
        { week_day: 1, is_available: true, start_hour: '08', end_hour: '18' },
      ];
      http.responder({
        data: {
          id: 6,
          organization_name: 'Loja',
          organization_cover_image: 'capa.png',
          template: 'online',
          title: 'Cupom',
          description: 'desc',
          activation_url: 'https://loja.teste/ativar',
          rules: 'regras',
          cashback_text: '2%',
          discount: 10,
          start_date: '2026-11-25T15:30:00.000Z',
          end_date: null,
          code: 'ABC',
          picture_small_url: 'p.png',
          picture_large_url: 'g.png',
          working_days: dias,
          extra: 'não sai',
        },
      });

      await expect(
        alloyal.getCouponDetail('MAIS_PRIME', 5, 6, sessao),
      ).resolves.toEqual({
        id: 6,
        organization_name: 'Loja',
        organization_cover_image: 'capa.png',
        template: 'online',
        title: 'Cupom',
        description: 'desc',
        activation_url: 'https://loja.teste/ativar',
        rules: 'regras',
        cashback_text: '2%',
        discount: 10,
        start_date: '25/11/2026',
        end_date: '',
        code: 'ABC',
        picture_small_url: 'p.png',
        picture_large_url: 'g.png',
        working_days: dias,
      });
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/organizations/5/coupons/6`,
        cabecalhos: cabecalhosDaSessao,
        timeout: 20_000,
      });
    });

    it('redeemCouponWithCode: GET /organizations/:id/orders com o cupom na query; devolve o corpo como veio', async () => {
      const pedido = { id: 1, number: 'N1', redeem_code: 'XYZ' };
      http.responder({ data: pedido });

      await expect(
        alloyal.redeemCouponWithCode('MAIS_PRIME', 5, { coupon_id: 6 }, sessao),
      ).resolves.toEqual(pedido);
      expect(http.requisicoes).toEqual([
        {
          metodo: 'GET',
          url: `${API}/organizations/5/orders`,
          params: { coupon_id: 6 },
          cabecalhos: cabecalhosDaSessao,
          timeout: 20_000,
        },
      ]);
    });

    it('listAllCouponOrders: GET /orders; devolve o corpo como veio', async () => {
      const pedidos = [{ id: 1, number: 'N1' }];
      http.responder({ data: pedidos });

      await expect(
        alloyal.listAllCouponOrders('MAIS_PRIME', sessao),
      ).resolves.toEqual(pedidos);
      expect(http.requisicoes).toEqual([
        {
          metodo: 'GET',
          url: `${API}/orders`,
          cabecalhos: cabecalhosDaSessao,
          timeout: 20_000,
        },
      ]);
    });

    it('redeemCouponGeneric: POST /orders com o cupom no corpo; devolve o corpo como veio', async () => {
      const pedido = { id: 2, number: 'N2' };
      http.responder({ status: 201, data: pedido });

      await expect(
        alloyal.redeemCouponGeneric('MAIS_PRIME', { coupon_id: 6 }, sessao),
      ).resolves.toEqual(pedido);
      expect(http.requisicoes).toEqual([
        {
          metodo: 'POST',
          url: `${API}/orders`,
          cabecalhos: cabecalhosDaSessao,
          corpo: { coupon_id: 6 },
          timeout: 20_000,
        },
      ]);
    });

    it('falha da Alloyal (404, 500, timeout) → rejeita', async () => {
      http.responder(
        { status: 404, data: { error: 'não encontrado' } },
        { status: 500, data: 'erro' },
        { falha: 'timeout' },
      );

      await expect(
        alloyal.getCouponDetail('MAIS_PRIME', 5, 6, sessao),
      ).rejects.toBeDefined();
      await expect(
        alloyal.redeemCouponGeneric('MAIS_PRIME', { coupon_id: 6 }, sessao),
      ).rejects.toBeDefined();
      await expect(
        alloyal.listAllCouponOrders('MAIS_PRIME', sessao),
      ).rejects.toBeDefined();
    });
  });
});

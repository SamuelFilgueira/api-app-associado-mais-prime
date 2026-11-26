import { Test } from '@nestjs/testing';
import { registroDeMetricas } from 'src/infra/observability/metricas';
import { AlloyalHttp } from 'src/integrations/alloyal/alloyal-http';
import { AlloyalClient } from 'src/integrations/alloyal/alloyal.client';
import {
  AlloyalGateway,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';
import { AlloyalModule } from 'src/integrations/alloyal/alloyal.module';
import {
  AlloyalHttpFalso,
  RespostaFalsa,
} from 'src/integrations/alloyal/testing/alloyal-http-falso';
import { IntegrationError } from 'src/shared/erros/erros';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';

describe('AlloyalClient', () => {
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
  const envOriginal = { ...process.env };

  const sessao: SessaoAlloyal = {
    uid: 'uid-1',
    client: 'client-1',
    accessToken: 'token-1',
  };

  const http = new AlloyalHttpFalso();
  let client: AlloyalClient;

  beforeEach(() => {
    Object.assign(process.env, ENVS);
    http.instalar();
    client = new AlloyalClient(
      new AlloyalHttp(new TenantCredentialsRegistry()),
    );
  });

  afterEach(() => {
    http.restaurar();
    process.env = { ...envOriginal };
  });

  const capturar = async (chamada: Promise<unknown>) => {
    const erro: unknown = await chamada.then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(IntegrationError);
    return erro as IntegrationError;
  };

  /** Valor atual de `vendor_requests_total{vendor="alloyal", ...}`. */
  const contador = async (
    operacao: string,
    resultado: string,
    base: string,
  ) => {
    const metrica = await registroDeMetricas
      .getSingleMetric('vendor_requests_total')!
      .get();
    return (
      metrica.values.find(
        (v) =>
          v.labels.vendor === 'alloyal' &&
          v.labels.operacao === operacao &&
          v.labels.resultado === resultado &&
          v.labels.base === base,
      )?.value ?? 0
    );
  };

  describe('credencial por base', () => {
    it('rotas de sessão usam o api-secret da base recebida — a mesma instância atende as duas', async () => {
      await client.listarCategorias('MAIS_PRIME', sessao);
      await client.listarCategorias('MAIS_PRIME_RS', sessao);
      await client.listarCategorias('MAIS_PRIME', sessao);

      expect(http.requisicoes.map((r) => r.cabecalhos['api-secret'])).toEqual([
        'segredo-mp',
        'segredo-rs',
        'segredo-mp',
      ]);
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: `${API}/categories`,
        cabecalhos: {
          uid: 'uid-1',
          client: 'client-1',
          'access-token': 'token-1',
          'api-secret': 'segredo-mp',
        },
        timeout: 20_000,
      });
    });

    it('login usa o api-secret da base recebida', async () => {
      http.responder({
        headers: { uid: 'u', client: 'c', 'access-token': 't' },
      });

      await expect(
        client.login('MAIS_PRIME_RS', '12345678900', 'senha'),
      ).resolves.toEqual({ uid: 'u', client: 'c', accessToken: 't' });
      expect(http.ultima).toMatchObject({
        metodo: 'POST',
        url: `${API}/auth/sign_in`,
        cabecalhos: { 'api-secret': 'segredo-rs' },
        corpo: { cpf: '12345678900', password: 'senha' },
      });
    });

    it('rotas administrativas usam o CNPJ do business da base e a credencial de employee', async () => {
      await client.buscarUsuariosPorCpf('MAIS_PRIME_RS', '123.456.789-00');
      expect(http.ultima).toEqual({
        metodo: 'GET',
        url: 'https://alloyal.teste/client/v2/businesses/22222222000122/users',
        params: { page: 1, active: true, term: '12345678900' },
        cabecalhos: {
          'x-clientemployee-email': 'employee@teste.local',
          'x-clientemployee-token': 'token-employee',
        },
        timeout: 20_000,
      });

      await client.atualizarUsuario('MAIS_PRIME', '123.456.789-00', {
        name: 'Novo',
      });
      expect(http.ultima).toMatchObject({
        metodo: 'PATCH',
        url: 'https://alloyal.teste/client/v2/businesses/11111111000111/users/12345678900',
        cabecalhos: { 'tentant-id': '11111111000111' },
        corpo: { name: 'Novo' },
      });
    });

    it.each([
      ['ausente', undefined],
      ['vazia', ''],
      ['de outro deploy', 'OUTRA_EMPRESA'],
    ])(
      'base %s → BaseNaoResolvidaError e nenhuma chamada',
      async (_caso, base) => {
        const invalida = base as string;

        await expect(
          client.login(invalida, '12345678900', 'senha'),
        ).rejects.toBeInstanceOf(BaseNaoResolvidaError);
        await expect(
          client.listarCategorias(invalida, sessao),
        ).rejects.toBeInstanceOf(BaseNaoResolvidaError);
        await expect(
          client.buscarUsuariosPorCpf(invalida, '12345678900'),
        ).rejects.toBeInstanceOf(BaseNaoResolvidaError);

        expect(http.requisicoes).toEqual([]);
      },
    );

    it('credencial da base não configurada → nao_configurada, sem usar a de outra base', async () => {
      delete process.env.API_SECRET_ALLOYAL_RS;

      const erro = await capturar(
        client.listarCategorias('MAIS_PRIME_RS', sessao),
      );

      expect(erro).toMatchObject({
        tipo: 'nao_configurada',
        vendor: 'alloyal',
        base: 'MAIS_PRIME_RS',
        statusHttp: 503,
      });
      expect(http.requisicoes).toEqual([]);
    });
  });

  describe('configuração que não varia por base', () => {
    it('sem BASE_URL_ALLOYAL → nao_configurada nas rotas de sessão, sem chamada', async () => {
      delete process.env.BASE_URL_ALLOYAL;

      const erro = await capturar(
        client.listarCategorias('MAIS_PRIME', sessao),
      );

      expect(erro).toMatchObject({
        tipo: 'nao_configurada',
        base: 'MAIS_PRIME',
        detalhes: { operacao: 'categorias', faltando: 'BASE_URL_ALLOYAL' },
      });
      expect(http.requisicoes).toEqual([]);
    });

    it('sem BASE_URL_ALLOYAL as rotas administrativas usam a origem padrão da Alloyal', async () => {
      delete process.env.BASE_URL_ALLOYAL;

      await client.buscarUsuariosPorCpf('MAIS_PRIME', '12345678900');

      expect(http.ultima.url).toBe(
        'https://api.lecupon.com/client/v2/businesses/11111111000111/users',
      );
    });

    it.each(['x_clientemployee_email', 'x_clientemployee_token'])(
      'sem %s → nao_configurada nas rotas administrativas, sem chamada',
      async (variavel) => {
        delete process.env[variavel];

        for (const chamada of [
          client.buscarUsuariosPorCpf('MAIS_PRIME', '12345678900'),
          client.criarUsuario('MAIS_PRIME', { cpf: '12345678900' }),
          client.atualizarUsuario('MAIS_PRIME', '900', { name: 'x' }),
        ]) {
          expect(await capturar(chamada)).toMatchObject({
            tipo: 'nao_configurada',
            vendor: 'alloyal',
          });
        }
        expect(http.requisicoes).toEqual([]);
      },
    );
  });

  describe('sessão do usuário', () => {
    it.each([
      ['ausente', undefined],
      ['sem uid', { ...sessao, uid: '' }],
      ['sem client', { ...sessao, client: '' }],
      ['sem access-token', { ...sessao, accessToken: '' }],
    ])('%s → autenticacao, sem chamada', async (_caso, incompleta) => {
      const erro = await capturar(
        client.listarPedidos('MAIS_PRIME', incompleta as SessaoAlloyal),
      );

      expect(erro).toMatchObject({ tipo: 'autenticacao', vendor: 'alloyal' });
      expect(erro.statusVendor).toBeUndefined();
      expect(http.requisicoes).toEqual([]);
    });
  });

  describe('classificação de erro', () => {
    const casos: Array<
      [
        string,
        RespostaFalsa,
        Partial<IntegrationError> & { statusHttp: number },
      ]
    > = [
      [
        'timeout',
        { falha: 'timeout' },
        { tipo: 'timeout', transitoria: true, statusHttp: 504 },
      ],
      [
        'sem conexão',
        { falha: 'rede' },
        { tipo: 'indisponivel', transitoria: true, statusHttp: 503 },
      ],
      [
        '401 da Alloyal',
        { status: 401, data: { errors: ['sessão expirada'] } },
        {
          tipo: 'autenticacao',
          statusVendor: 401,
          transitoria: false,
          statusHttp: 503,
        },
      ],
      [
        '403 da Alloyal',
        { status: 403, data: { errors: ['desativado'] } },
        {
          tipo: 'autenticacao',
          statusVendor: 403,
          transitoria: false,
          statusHttp: 503,
        },
      ],
      [
        '404 da Alloyal',
        { status: 404, data: { error: 'não encontrado' } },
        {
          tipo: 'recusado',
          statusVendor: 404,
          transitoria: false,
          statusHttp: 502,
        },
      ],
      [
        '422 da Alloyal',
        { status: 422, data: { errors: ['cupom esgotado'] } },
        {
          tipo: 'recusado',
          statusVendor: 422,
          transitoria: false,
          statusHttp: 502,
        },
      ],
      [
        '429 da Alloyal',
        { status: 429, data: '' },
        {
          tipo: 'indisponivel',
          statusVendor: 429,
          transitoria: true,
          statusHttp: 503,
        },
      ],
      [
        '500 da Alloyal',
        { status: 500, data: '<html>erro</html>' },
        {
          tipo: 'indisponivel',
          statusVendor: 500,
          transitoria: true,
          statusHttp: 503,
        },
      ],
      [
        '503 da Alloyal',
        { status: 503, data: null },
        {
          tipo: 'indisponivel',
          statusVendor: 503,
          transitoria: true,
          statusHttp: 503,
        },
      ],
      [
        '200 com HTML de proxy no lugar do JSON',
        { status: 200, data: '<html>manutenção</html>' },
        {
          tipo: 'resposta_invalida',
          statusVendor: 200,
          transitoria: false,
          statusHttp: 502,
        },
      ],
    ];

    it.each(casos)(
      '%s → IntegrationError certo, com a operação e a base',
      async (_caso, resposta, esperado) => {
        http.responder(resposta);

        const erro = await capturar(client.listarPedidos('MAIS_PRIME', sessao));

        expect(erro).toMatchObject({
          vendor: 'alloyal',
          base: 'MAIS_PRIME',
          ...esperado,
        });
        expect(erro.detalhes).toMatchObject({ operacao: 'pedidos' });
        expect(http.requisicoes).toHaveLength(1);
      },
    );

    it('a mesma classificação vale para login e para as rotas administrativas', async () => {
      http.responder(
        { status: 401, data: { errors: ['Invalid login credentials'] } },
        { status: 422, data: { errors: ['email inválido'] } },
        { falha: 'timeout' },
      );

      expect(
        await capturar(client.login('MAIS_PRIME', '12345678900', 'errada')),
      ).toMatchObject({
        tipo: 'autenticacao',
        statusVendor: 401,
        detalhes: { operacao: 'login' },
      });
      expect(
        await capturar(client.criarUsuario('MAIS_PRIME', { cpf: '1' })),
      ).toMatchObject({
        tipo: 'recusado',
        statusVendor: 422,
        detalhes: { operacao: 'usuario_criar' },
      });
      expect(
        await capturar(client.buscarUsuariosPorCpf('MAIS_PRIME', '1')),
      ).toMatchObject({
        tipo: 'timeout',
        detalhes: { operacao: 'usuario_buscar' },
      });
    });

    it('corpo fora do formato esperado pela operação → resposta_invalida', async () => {
      http.responder(
        { data: { organizations: [] } }, // lista esperada, veio objeto
        { data: null }, // lista esperada, veio vazio
        { data: [{ id: 1 }] }, // objeto esperado, veio lista
        { data: null }, // objeto esperado, veio vazio
      );

      for (const chamada of [
        client.listarOrganizacoes('MAIS_PRIME', sessao, { page: 1 }),
        client.listarDestaquesOnline('MAIS_PRIME', sessao),
        client.detalharCupom('MAIS_PRIME', sessao, 5, 6),
        client.detalharCupom('MAIS_PRIME', sessao, 5, 6),
      ]) {
        expect(await capturar(chamada)).toMatchObject({
          tipo: 'resposta_invalida',
          statusVendor: 200,
        });
      }
    });

    it('operações que repassam o corpo aceitam qualquer JSON (inclusive vazio), mas não texto solto', async () => {
      http.responder(
        { data: { qualquer: 'objeto' } },
        { data: null },
        { data: '' },
        { status: 204, data: '' },
        { data: '{"json": "truncad' },
      );

      await expect(
        client.listarCategorias('MAIS_PRIME', sessao),
      ).resolves.toEqual({ qualquer: 'objeto' });
      await expect(
        client.consultarCashback('MAIS_PRIME', sessao),
      ).resolves.toBeNull();
      await expect(client.listarPedidos('MAIS_PRIME', sessao)).resolves.toBe(
        '',
      );
      await expect(
        client.solicitarResgateDeCashback('MAIS_PRIME', sessao, { cpf: '1' }),
      ).resolves.toBeUndefined();
      expect(
        await capturar(client.listarCategorias('MAIS_PRIME', sessao)),
      ).toMatchObject({ tipo: 'resposta_invalida' });
    });

    it('login que responde 2xx sem os cabeçalhos de sessão → resposta_invalida', async () => {
      http.responder({ data: {}, headers: { uid: 'u', client: 'c' } });

      const erro = await capturar(
        client.login('MAIS_PRIME', '12345678900', 'senha'),
      );

      expect(erro).toMatchObject({
        tipo: 'resposta_invalida',
        statusVendor: 200,
        detalhes: { operacao: 'login' },
      });
    });

    it('o erro não carrega credencial, sessão nem o corpo enviado', async () => {
      http.responder({ status: 422, data: { errors: ['recusado'] } });

      const erro = await capturar(
        client.login('MAIS_PRIME', '12345678900', 'senha-secreta'),
      );
      const tudo = JSON.stringify({
        ...erro,
        message: erro.message,
        stack: erro.stack,
        causa: erro.causa,
      });

      expect(tudo).not.toContain('segredo-mp');
      expect(tudo).not.toContain('senha-secreta');
      expect(tudo).not.toContain('token-employee');
      expect(erro.causa).toBeUndefined();
      // O que a Alloyal respondeu fica no detalhe (vai só para o log).
      expect(erro.detalhes).toMatchObject({
        respostaVendor: '{"errors":["recusado"]}',
      });
      // E a mensagem para o cliente é neutra.
      expect(erro.message).not.toMatch(/alloyal|recusado/i);
    });
  });

  describe('caminho e parâmetros', () => {
    it('o id da categoria é codificado: não escapa do caminho da rota', async () => {
      await client.listarOrganizacoesDaCategoria(
        'MAIS_PRIME',
        sessao,
        '../../orders',
        { page: 1 },
      );

      expect(http.ultima.url).toBe(
        `${API}/categories/..%2F..%2Forders/organizations`,
      );
    });

    it('o identificador do usuário vai só com os dígitos', async () => {
      await client.atualizarUsuario('MAIS_PRIME', '900/../x', {});

      expect(http.ultima.url).toBe(
        'https://alloyal.teste/client/v2/businesses/11111111000111/users/900',
      );
    });

    it('os resgates mandam o cupom na query (com código) e no corpo (genérico)', async () => {
      http.responderSempre({ data: { id: 1 } });

      await client.resgatarCupomComCodigo('MAIS_PRIME', sessao, 5, {
        coupon_id: 6,
      });
      expect(http.ultima).toMatchObject({
        metodo: 'GET',
        url: `${API}/organizations/5/orders`,
        params: { coupon_id: 6 },
      });

      await client.resgatarCupom('MAIS_PRIME', sessao, { coupon_id: 6 });
      expect(http.ultima).toMatchObject({
        metodo: 'POST',
        url: `${API}/orders`,
        corpo: { coupon_id: 6 },
      });
    });
  });

  describe('métricas', () => {
    it('conta cada chamada por operação, base e resultado (timeout à parte)', async () => {
      const antes = {
        ok: await contador('pedidos', 'ok', 'MAIS_PRIME_RS'),
        erro: await contador('pedidos', 'erro', 'MAIS_PRIME_RS'),
        timeout: await contador('pedidos', 'timeout', 'MAIS_PRIME_RS'),
      };
      http.responder(
        { data: [] },
        { status: 500, data: 'erro' },
        { falha: 'timeout' },
        { data: '<html>' },
      );

      await client.listarPedidos('MAIS_PRIME_RS', sessao);
      await capturar(client.listarPedidos('MAIS_PRIME_RS', sessao));
      await capturar(client.listarPedidos('MAIS_PRIME_RS', sessao));
      await capturar(client.listarPedidos('MAIS_PRIME_RS', sessao));

      expect(await contador('pedidos', 'ok', 'MAIS_PRIME_RS')).toBe(
        antes.ok + 1,
      );
      expect(await contador('pedidos', 'erro', 'MAIS_PRIME_RS')).toBe(
        antes.erro + 2,
      );
      expect(await contador('pedidos', 'timeout', 'MAIS_PRIME_RS')).toBe(
        antes.timeout + 1,
      );
    });

    it('chamada que não sai (base inválida, sem credencial) não entra na métrica', async () => {
      const antes = await contador('categorias', 'erro', 'OUTRA_EMPRESA');

      await expect(
        client.listarCategorias('OUTRA_EMPRESA', sessao),
      ).rejects.toBeInstanceOf(BaseNaoResolvidaError);

      expect(await contador('categorias', 'erro', 'OUTRA_EMPRESA')).toBe(antes);
    });
  });

  it('o módulo entrega a porta AlloyalGateway como singleton (sem escopo REQUEST)', async () => {
    // Em produção o registry vem do `SharedModule`, que é global.
    const modulo = await Test.createTestingModule({ imports: [AlloyalModule] })
      .useMocker((token) =>
        token === TenantCredentialsRegistry
          ? new TenantCredentialsRegistry()
          : undefined,
      )
      .compile();

    // `get()` lança para providers de escopo REQUEST/TRANSIENT.
    const porta = modulo.get(AlloyalGateway);
    expect(porta).toBeInstanceOf(AlloyalClient);
    expect(modulo.get(AlloyalClient)).toBe(porta);
  });
});

import axios, { AxiosResponse } from 'axios';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { TokenResolverService } from 'src/shared/token-resolver.service';
import { IntegrationError } from 'src/shared/erros/erros';
import { SgaAuthService, operacaoDaUrl } from './sga-auth.service';

jest.mock('axios');
const axiosPost = jest.spyOn(axios, 'post');
const axiosRequest = jest.spyOn(axios, 'request');

const resp = <T>(status: number, data: T): AxiosResponse<T> =>
  ({
    status,
    statusText: '',
    headers: {},
    config: {},
    data,
  }) as AxiosResponse<T>;

const BLOQUEIO = {
  mensagem: 'Forbidden',
  error: ['Token BLOQUEADO temporariamente por excesso de extracao de DADOS'],
};

function resolverCom(tokens: string[]): TokenResolverService {
  return {
    resolveSgaUser: jest.fn().mockReturnValue('usuario'),
    resolveSgaPassword: jest.fn().mockReturnValue('senha'),
    resolveSgaBaseTokens: jest.fn().mockReturnValue(tokens),
  } as unknown as TokenResolverService;
}

/** Cada login devolve um token novo: `sessao-1`, `sessao-2`... */
function loginSequencial() {
  let n = 0;
  axiosPost.mockImplementation(() =>
    Promise.resolve(resp(200, { token_usuario: `sessao-${++n}` })),
  );
}

const pedido = { method: 'GET' as const, url: 'https://sga.teste/x' };
const tokenUsado = (chamada: number) =>
  (
    axiosRequest.mock.calls[chamada][0] as {
      headers: { Authorization: string };
    }
  ).headers.Authorization;

/**
 * Duas instâncias do service com o MESMO store simulam duas réplicas da API
 * compartilhando a sessão pelo Redis.
 */
describe('SgaAuthService — sessão compartilhada entre réplicas', () => {
  let store: VendorSessionStore;
  let a: SgaAuthService;
  let b: SgaAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    store = VendorSessionStore.emMemoria();
    a = new SgaAuthService(resolverCom(['base-1']), store);
    b = new SgaAuthService(resolverCom(['base-1']), store);
  });

  it('a segunda réplica reaproveita o login da primeira', async () => {
    loginSequencial();

    await expect(a.getUserToken('MAIS_PRIME')).resolves.toBe('sessao-1');
    await expect(b.getUserToken('MAIS_PRIME')).resolves.toBe('sessao-1');

    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it('401 em uma réplica renova a sessão; a outra adota a nova sem novo login', async () => {
    loginSequencial();
    await a.getUserToken('MAIS_PRIME');
    await b.getUserToken('MAIS_PRIME');

    // A Hinova passa a recusar `sessao-1`.
    axiosRequest.mockImplementation((config) => {
      const auth = (config as { headers: { Authorization: string } }).headers
        .Authorization;
      return Promise.resolve(
        auth === 'Bearer sessao-1' ? resp(401, {}) : resp(200, { ok: true }),
      );
    });

    await expect(
      a.executeRequestWithAuth('MAIS_PRIME', pedido),
    ).resolves.toMatchObject({
      status: 200,
    });
    expect(axiosPost).toHaveBeenCalledTimes(2);

    // A réplica B ainda tem `sessao-1` na memória: leva o 401, vê no store
    // que já existe sessão nova e a usa — sem um terceiro login.
    await expect(
      b.executeRequestWithAuth('MAIS_PRIME', pedido),
    ).resolves.toMatchObject({
      status: 200,
    });
    expect(axiosPost).toHaveBeenCalledTimes(2);
    expect(tokenUsado(axiosRequest.mock.calls.length - 1)).toBe(
      'Bearer sessao-2',
    );
  });

  it('401 tardio de token antigo não apaga a sessão nova', async () => {
    loginSequencial();
    await a.getUserToken('MAIS_PRIME'); // sessao-1
    axiosRequest.mockResolvedValueOnce(resp(401, {})); // derruba a sessao-1
    axiosRequest.mockResolvedValue(resp(200, {}));
    await a.executeRequestWithAuth('MAIS_PRIME', pedido); // loga a sessao-2

    await store.apagar('hinova', 'usuario:MAIS_PRIME:0', 'sessao-1');

    await expect(store.ler('hinova', 'usuario:MAIS_PRIME:0')).resolves.toBe(
      'sessao-2',
    );
  });

  it('token de base bloqueado em uma réplica sai da rotação também na outra', async () => {
    a = new SgaAuthService(resolverCom(['base-1', 'base-2']), store);
    b = new SgaAuthService(resolverCom(['base-1', 'base-2']), store);
    axiosPost.mockImplementation((_url, _body, cfg) => {
      const base = (
        cfg as { headers: { Authorization: string } }
      ).headers.Authorization.replace('Bearer ', '');
      return Promise.resolve(resp(200, { token_usuario: `user-de-${base}` }));
    });
    axiosRequest.mockImplementation((config) => {
      const auth = (config as { headers: { Authorization: string } }).headers
        .Authorization;
      return Promise.resolve(
        auth === 'Bearer user-de-base-1'
          ? resp(403, BLOQUEIO)
          : resp(200, { ok: true }),
      );
    });

    await a.executeRequestWithAuth('MAIS_PRIME', pedido);
    expect(a.estadoTokensBase('MAIS_PRIME').bloqueados).toEqual([0]);

    axiosRequest.mockClear();
    await b.executeRequestWithAuth('MAIS_PRIME', pedido);
    await b.executeRequestWithAuth('MAIS_PRIME', pedido);

    // A réplica B nunca chegou a usar o token bloqueado.
    expect(axiosRequest.mock.calls.map((_c, i) => tokenUsado(i))).toEqual([
      'Bearer user-de-base-2',
      'Bearer user-de-base-2',
    ]);
    expect(b.estadoTokensBase('MAIS_PRIME').bloqueados).toEqual([0]);
  });
});

describe('SgaAuthService — disjuntor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-11-25T12:00:00Z') });
    axiosPost.mockResolvedValue(resp(200, { token_usuario: 'sessao' }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cinco falhas de transporte abrem o circuito: a sexta falha na hora, sem chamar a Hinova', async () => {
    const svc = new SgaAuthService(resolverCom(['base-1']));
    axiosRequest.mockRejectedValue(
      Object.assign(new Error('timeout of 45000ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    );

    for (let i = 0; i < 5; i++) {
      await expect(
        svc.executeRequestWithAuth('MAIS_PRIME', pedido),
      ).rejects.toThrow('timeout');
    }
    axiosRequest.mockClear();

    const erro = await svc
      .executeRequestWithAuth('MAIS_PRIME', pedido)
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(IntegrationError);
    expect(erro).toMatchObject({ tipo: 'circuito_aberto', statusHttp: 503 });
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('o circuito é por base: outra base segue sendo atendida', async () => {
    const svc = new SgaAuthService(resolverCom(['base-1']));
    axiosRequest.mockRejectedValue(new Error('ECONNRESET'));
    for (let i = 0; i < 5; i++) {
      await svc.executeRequestWithAuth('MAIS_PRIME', pedido).catch(() => null);
    }

    axiosRequest.mockResolvedValue(resp(200, { ok: true }));
    await expect(
      svc.executeRequestWithAuth('MAIS_PRIME_RS', pedido),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('depois de 30 s uma sonda passa; dando certo, o circuito fecha', async () => {
    const svc = new SgaAuthService(resolverCom(['base-1']));
    axiosRequest.mockResolvedValue(resp(503, 'fora'));
    for (let i = 0; i < 5; i++) {
      await svc.executeRequestWithAuth('MAIS_PRIME', pedido);
    }
    await expect(
      svc.executeRequestWithAuth('MAIS_PRIME', pedido),
    ).rejects.toMatchObject({
      tipo: 'circuito_aberto',
    });

    jest.advanceTimersByTime(30_001);
    axiosRequest.mockResolvedValue(resp(200, { ok: true }));

    await expect(
      svc.executeRequestWithAuth('MAIS_PRIME', pedido),
    ).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      svc.executeRequestWithAuth('MAIS_PRIME', pedido),
    ).resolves.toMatchObject({
      status: 200,
    });
  });

  it('403 de bloqueio e 4xx de negócio não contam como falha do vendor', async () => {
    const svc = new SgaAuthService(resolverCom(['base-1']));
    axiosRequest.mockResolvedValue(resp(406, { mensagem: 'Não aceitável' }));

    for (let i = 0; i < 12; i++) {
      await expect(
        svc.executeRequestWithAuth('MAIS_PRIME', pedido),
      ).resolves.toMatchObject({ status: 406 });
    }
  });
});

describe('operacaoDaUrl', () => {
  it('troca valores por :id e descarta a query', () => {
    expect(
      operacaoDaUrl('https://sga.teste/associado/buscar/52998224725'),
    ).toBe('/associado/buscar/:id');
    expect(
      operacaoDaUrl('https://sga.teste/veiculo/alterar-situacao-para/1/55?x=1'),
    ).toBe('/veiculo/alterar-situacao-para/:id/:id');
    expect(
      operacaoDaUrl('https://sga.teste/listar/boleto-associado-veiculo'),
    ).toBe('/listar/boleto-associado-veiculo');
    expect(operacaoDaUrl(undefined)).toBe('desconhecida');
  });
});

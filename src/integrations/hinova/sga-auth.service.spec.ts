import axios, { AxiosResponse } from 'axios';
import { SgaAuthService, ehBloqueioPorExtracao } from './sga-auth.service';
import { TokenResolverService } from 'src/shared/token-resolver.service';

jest.mock('axios');
const axiosPost = jest.spyOn(axios, 'post');

const BLOQUEIO = {
  mensagem: 'Forbidden',
  error: [
    'Token BLOQUEADO temporariamente por excesso de extracao de DADOS. A liberacao ocorrera AUTOMATICAMENTE apos alguns minutos',
  ],
};

const resp = <T>(status: number, data: T): AxiosResponse<T> =>
  ({
    status,
    statusText: '',
    headers: {},
    config: {},
    data,
  }) as AxiosResponse<T>;

function resolverCom(tokens: string[]): TokenResolverService {
  return {
    resolveSgaUser: jest.fn().mockReturnValue('usuario'),
    resolveSgaPassword: jest.fn().mockReturnValue('senha'),
    resolveSgaBaseTokens: jest.fn().mockReturnValue(tokens),
    resolveSgaBaseToken: jest.fn().mockReturnValue(tokens[0]),
  } as unknown as TokenResolverService;
}

/** Simula a Hinova: login aceito só com os tokens de base NÃO bloqueados. */
function loginHinova(bloqueados: Set<string>) {
  return (
    _url: string,
    _body: unknown,
    cfg: { headers: { Authorization: string } },
  ) => {
    const base = cfg.headers.Authorization.replace('Bearer ', '');
    if (bloqueados.has(base)) return Promise.resolve(resp(403, BLOQUEIO));
    return Promise.resolve(resp(200, { token_usuario: `user-de-${base}` }));
  };
}

/** Token de base usado em cada login (ordem das chamadas a axios.post). */
function basesLogadas(): string[] {
  return axiosPost.mock.calls.map((call) =>
    (
      call[2] as { headers: { Authorization: string } }
    ).headers.Authorization.replace('Bearer ', ''),
  );
}

describe('ehBloqueioPorExtracao', () => {
  it('reconhece o 403 de bloqueio, com e sem acento, e ignora os demais', () => {
    expect(ehBloqueioPorExtracao(403, BLOQUEIO)).toBe(true);
    expect(
      ehBloqueioPorExtracao(403, { error: ['token bloqueado por extração'] }),
    ).toBe(true);
    expect(ehBloqueioPorExtracao(403, { mensagem: 'Forbidden' })).toBe(false);
    expect(ehBloqueioPorExtracao(401, BLOQUEIO)).toBe(false);
    expect(ehBloqueioPorExtracao(403, null)).toBe(false);
  });
});

describe('SgaAuthService — rotação dos tokens de base', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('alterna os tokens a cada requisição e mantém uma sessão por token (um login cada)', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2', 'base-3']));
    const makeRequest = jest.fn().mockResolvedValue(resp(200, { ok: true }));

    for (let i = 0; i < 6; i++) {
      await svc.executeWithAuth('MAIS_PRIME', makeRequest);
    }

    expect(basesLogadas()).toEqual(['base-1', 'base-2', 'base-3']);
    expect(makeRequest.mock.calls.map((c) => c[0])).toEqual([
      'user-de-base-1',
      'user-de-base-2',
      'user-de-base-3',
      'user-de-base-1',
      'user-de-base-2',
      'user-de-base-3',
    ]);
  });

  it('com um único token o comportamento é o de sempre (um login, sessão reutilizada)', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-unico']));
    const makeRequest = jest.fn().mockResolvedValue(resp(200, {}));

    await svc.executeWithAuth('HERTZ', makeRequest);
    await svc.executeWithAuth('HERTZ', makeRequest);

    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(makeRequest).toHaveBeenNthCalledWith(2, 'user-de-base-unico');
  });

  it('login: token bloqueado sai da rotação; os demais seguem sendo usados', async () => {
    axiosPost.mockImplementation(loginHinova(new Set(['base-2'])) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2', 'base-3']));
    const makeRequest = jest.fn().mockResolvedValue(resp(200, {}));

    for (let i = 0; i < 4; i++) {
      await svc.executeWithAuth('MAIS_PRIME', makeRequest);
    }

    expect(basesLogadas()).toEqual(['base-1', 'base-2', 'base-3']);
    expect(makeRequest.mock.calls.map((c) => c[0])).toEqual([
      'user-de-base-1',
      'user-de-base-3',
      'user-de-base-1',
      'user-de-base-3',
    ]);
    expect(svc.estadoTokensBase('MAIS_PRIME')).toEqual({
      total: 3,
      ultimoUsado: 2,
      bloqueados: [1],
    });
  });

  it('requisição: 403 de bloqueio → tira o token da rotação e repete UMA vez com outro', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));
    const makeRequest = jest.fn(
      (tokenUsuario: string): Promise<AxiosResponse<unknown>> =>
        Promise.resolve(
          tokenUsuario === 'user-de-base-1'
            ? resp<unknown>(403, BLOQUEIO)
            : resp<unknown>(200, { ok: true }),
        ),
    );

    const resultado = await svc.executeWithAuth('MAIS_PRIME', makeRequest);

    expect(resultado.status).toBe(200);
    expect(makeRequest).toHaveBeenNthCalledWith(1, 'user-de-base-1');
    expect(makeRequest).toHaveBeenNthCalledWith(2, 'user-de-base-2');
    expect(svc.estadoTokensBase('MAIS_PRIME').bloqueados).toEqual([0]);

    // Próximas requisições não voltam ao token 1 enquanto ele está bloqueado
    await svc.executeWithAuth('MAIS_PRIME', makeRequest);
    expect(makeRequest).toHaveBeenNthCalledWith(3, 'user-de-base-2');
  });

  it('token bloqueado volta a ser sondado depois de 60s', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));
    let bloquearBase1 = true;
    const makeRequest = jest.fn(
      (tokenUsuario: string): Promise<AxiosResponse<unknown>> =>
        Promise.resolve(
          bloquearBase1 && tokenUsuario === 'user-de-base-1'
            ? resp<unknown>(403, BLOQUEIO)
            : resp<unknown>(200, { ok: true }),
        ),
    );

    await svc.executeWithAuth('MAIS_PRIME', makeRequest); // base-1 bloqueia → base-2
    jest.advanceTimersByTime(61_000);
    bloquearBase1 = false; // Hinova liberou

    await svc.executeWithAuth('MAIS_PRIME', makeRequest);
    expect(makeRequest).toHaveBeenLastCalledWith('user-de-base-1');
    expect(svc.estadoTokensBase('MAIS_PRIME').bloqueados).toEqual([]);
  });

  it('requisição: 403 de bloqueio com um único token → devolve o 403 como antes, sem reautenticar', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-unico']));
    const makeRequest = jest.fn().mockResolvedValue(resp(403, BLOQUEIO));

    const resultado = await svc.executeWithAuth('HERTZ', makeRequest);

    expect(resultado.status).toBe(403);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(axiosPost).toHaveBeenCalledTimes(1); // só o login inicial
  });

  it('403 comum (sem mensagem de bloqueio) não tira o token da rotação', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));
    const makeRequest = jest
      .fn()
      .mockResolvedValue(resp(403, { mensagem: 'Forbidden' }));

    const resultado = await svc.executeWithAuth('MAIS_PRIME', makeRequest);

    expect(resultado.status).toBe(403);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(svc.estadoTokensBase('MAIS_PRIME').bloqueados).toEqual([]);
  });

  it('401 reautentica a MESMA sessão e repete a requisição', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));
    let chamadas = 0;
    const makeRequest = jest.fn(() =>
      Promise.resolve(++chamadas === 1 ? resp(401, {}) : resp(200, { ok: 1 })),
    );

    const resultado = await svc.executeWithAuth('MAIS_PRIME', makeRequest);

    expect(resultado.status).toBe(200);
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(basesLogadas()).toEqual(['base-1', 'base-1']);
  });

  it('requisição com failoverTokenBase=false: 403 de bloqueio volta ao chamador sem repetir com outro token', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));
    const makeRequest = jest.fn().mockResolvedValue(resp(403, BLOQUEIO));

    const resultado = await svc.executeWithAuth('MAIS_PRIME', makeRequest, {
      failoverTokenBase: false,
    });

    expect(resultado.status).toBe(403);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(axiosPost).toHaveBeenCalledTimes(1);
    // O token bloqueado sai da rotação mesmo assim: a próxima vai para o outro
    expect(svc.estadoTokensBase('MAIS_PRIME').bloqueados).toEqual([0]);
  });
});

describe('SgaAuthService — todos bloqueados e pausa de login', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('todos os tokens bloqueados: falha após uma volta; por 60s as requisições falham sem chamar a Hinova; depois volta a sondar', async () => {
    axiosPost.mockImplementation(
      loginHinova(new Set(['base-1', 'base-2'])) as any,
    );
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));

    await expect(svc.getUserToken('MAIS_PRIME')).rejects.toThrow(
      'todos os 2 token(s) de base estão bloqueados',
    );
    expect(axiosPost).toHaveBeenCalledTimes(2); // uma volta completa

    jest.advanceTimersByTime(30_000);
    await expect(svc.executeWithAuth('MAIS_PRIME', jest.fn())).rejects.toThrow(
      'Falha ao autenticar',
    );
    expect(axiosPost).toHaveBeenCalledTimes(2); // nenhuma chamada nova

    jest.advanceTimersByTime(31_000);
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    await expect(svc.getUserToken('MAIS_PRIME')).resolves.toMatch(
      /^user-de-base-/,
    );
    expect(axiosPost).toHaveBeenCalledTimes(3);
  });

  it('falha comum de login (ex.: HTTP 500): pausa de 15s em vez de repetir o login a cada requisição', async () => {
    axiosPost.mockResolvedValue(resp(500, { mensagem: 'erro' }) as any);
    const svc = new SgaAuthService(resolverCom(['base-unico']));

    await expect(svc.executeWithAuth('HERTZ', jest.fn())).rejects.toThrow(
      'Falha ao autenticar',
    );
    await expect(svc.executeWithAuth('HERTZ', jest.fn())).rejects.toThrow(
      'nova tentativa de login em',
    );
    expect(axiosPost).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(15_000);
    await expect(svc.executeWithAuth('HERTZ', jest.fn())).rejects.toThrow(
      'Falha ao autenticar',
    );
    expect(axiosPost).toHaveBeenCalledTimes(2);
  });

  it('login bem-sucedido limpa a pausa e a sessão fica em cache', async () => {
    axiosPost
      .mockResolvedValueOnce(resp(500, {}) as any)
      .mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1']));

    await expect(svc.getUserToken('HERTZ')).rejects.toThrow(
      'Falha ao autenticar',
    );
    jest.advanceTimersByTime(15_000);
    await expect(svc.getUserToken('HERTZ')).resolves.toBe('user-de-base-1');
    await expect(svc.getUserToken('HERTZ')).resolves.toBe('user-de-base-1');
    expect(axiosPost).toHaveBeenCalledTimes(2);
  });
});

describe('SgaAuthService — executeRequestWithAuth', () => {
  let axiosRequest: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    axiosRequest = jest.spyOn(axios, 'request');
  });

  it('não repassa as opções do SGA ao axios', async () => {
    axiosRequest.mockResolvedValue(resp(200, { ok: true }));
    const svc = new SgaAuthService(resolverCom(['base-1']));

    await svc.executeRequestWithAuth('HERTZ', {
      method: 'GET',
      url: 'https://sga.test/x',
      failoverTokenBase: false,
      compartilharEmVoo: true,
    });

    const configEnviada = axiosRequest.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(configEnviada).not.toHaveProperty('failoverTokenBase');
    expect(configEnviada).not.toHaveProperty('compartilharEmVoo');
    expect(configEnviada.headers).toEqual({
      Authorization: 'Bearer user-de-base-1',
    });
  });

  it('compartilharEmVoo: requisições idênticas concorrentes fazem UMA chamada à Hinova e recebem a mesma resposta', async () => {
    let liberar: (value: AxiosResponse<unknown>) => void = () => undefined;
    axiosRequest.mockImplementation(
      () => new Promise((resolve) => (liberar = resolve)),
    );
    const svc = new SgaAuthService(resolverCom(['base-1']));
    const config = {
      method: 'GET',
      url: 'https://sga.test/associado/buscar/123',
      compartilharEmVoo: true,
    };

    const a = svc.executeRequestWithAuth('HERTZ', config);
    const b = svc.executeRequestWithAuth('HERTZ', config);
    // deixa o login terminar e a chamada chegar ao axios
    await new Promise((resolve) => setImmediate(resolve));
    expect(axiosRequest).toHaveBeenCalledTimes(1);
    liberar(resp(200, { nome: 'Fulano' }));

    const [ra, rb] = await Promise.all([a, b]);
    expect(axiosRequest).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);

    // Depois de concluída, uma nova chamada idêntica vai à Hinova de novo
    axiosRequest.mockResolvedValue(resp(200, { nome: 'Fulano' }));
    await svc.executeRequestWithAuth('HERTZ', config);
    expect(axiosRequest).toHaveBeenCalledTimes(2);
  });

  it('compartilharEmVoo distingue base, URL e corpo', async () => {
    axiosRequest.mockResolvedValue(resp(200, {}));
    const svc = new SgaAuthService(resolverCom(['base-1']));

    await Promise.all([
      svc.executeRequestWithAuth('HERTZ', {
        method: 'POST',
        url: 'https://sga.test/listar',
        data: { codigo_veiculo: 1 },
        compartilharEmVoo: true,
      }),
      svc.executeRequestWithAuth('HERTZ', {
        method: 'POST',
        url: 'https://sga.test/listar',
        data: { codigo_veiculo: 2 },
        compartilharEmVoo: true,
      }),
      svc.executeRequestWithAuth('HERTZ', {
        method: 'POST',
        url: 'https://sga.test/listar',
        data: { codigo_veiculo: 1 },
        compartilharEmVoo: true,
      }),
    ]);

    expect(axiosRequest).toHaveBeenCalledTimes(2);
  });

  it('sem compartilharEmVoo, cada requisição vai à Hinova', async () => {
    axiosRequest.mockResolvedValue(resp(200, {}));
    const svc = new SgaAuthService(resolverCom(['base-1']));
    const config = { method: 'GET', url: 'https://sga.test/x' };

    await Promise.all([
      svc.executeRequestWithAuth('HERTZ', config),
      svc.executeRequestWithAuth('HERTZ', config),
    ]);

    expect(axiosRequest).toHaveBeenCalledTimes(2);
  });
});

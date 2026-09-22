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

describe('SgaAuthService — failover de token de base', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('login: token 1 bloqueado → usa o token 2 e permanece nele nos próximos logins', async () => {
    axiosPost.mockImplementation(loginHinova(new Set(['base-1'])) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));

    const token = await svc.getUserToken('MAIS_PRIME');

    expect(token).toBe('user-de-base-2');
    expect(axiosPost).toHaveBeenCalledTimes(2); // base-1 (403) + base-2 (200)
    expect(svc.tokenBaseAtivo('MAIS_PRIME')).toEqual({ indice: 1, total: 2 });

    // Novo login (cache invalidado) começa direto pelo token 2
    svc.invalidateUserToken('MAIS_PRIME');
    await svc.getUserToken('MAIS_PRIME');
    expect(axiosPost).toHaveBeenCalledTimes(3);
    const ultimaAuth = axiosPost.mock.calls[2][2] as {
      headers: { Authorization: string };
    };
    expect(ultimaAuth.headers.Authorization).toBe('Bearer base-2');
  });

  it('login: todos os tokens bloqueados → falha após uma volta completa', async () => {
    axiosPost.mockImplementation(
      loginHinova(new Set(['base-1', 'base-2'])) as any,
    );
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));

    await expect(svc.getUserToken('MAIS_PRIME')).rejects.toThrow(
      'Falha ao autenticar',
    );
    expect(axiosPost).toHaveBeenCalledTimes(2);
  });

  it('requisição: 403 de bloqueio → troca o token de base, reautentica e repete uma vez', async () => {
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
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(makeRequest).toHaveBeenNthCalledWith(1, 'user-de-base-1');
    expect(makeRequest).toHaveBeenNthCalledWith(2, 'user-de-base-2');
    expect(svc.tokenBaseAtivo('MAIS_PRIME')).toEqual({ indice: 1, total: 2 });
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

  it('403 comum (sem mensagem de bloqueio) não aciona failover', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));
    const makeRequest = jest
      .fn()
      .mockResolvedValue(resp(403, { mensagem: 'Forbidden' }));

    const resultado = await svc.executeWithAuth('MAIS_PRIME', makeRequest);

    expect(resultado.status).toBe(403);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(svc.tokenBaseAtivo('MAIS_PRIME')).toEqual({ indice: 0, total: 2 });
  });

  it('401 continua reautenticando com o MESMO token de base e repetindo a requisição', async () => {
    axiosPost.mockImplementation(loginHinova(new Set()) as any);
    const svc = new SgaAuthService(resolverCom(['base-1', 'base-2']));
    let chamadas = 0;
    const makeRequest = jest.fn(() =>
      Promise.resolve(++chamadas === 1 ? resp(401, {}) : resp(200, { ok: 1 })),
    );

    const resultado = await svc.executeWithAuth('MAIS_PRIME', makeRequest);

    expect(resultado.status).toBe(200);
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(svc.tokenBaseAtivo('MAIS_PRIME')).toEqual({ indice: 0, total: 2 });
  });
});

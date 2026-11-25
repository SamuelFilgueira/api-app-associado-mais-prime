import axios, { AxiosError, AxiosResponse } from 'axios';
import { ClubgasClient, postosRecusadosPelaPlaca } from './clubgas.client';
import { ClubgasErro, clubgasErroParaHttp } from './clubgas.erro';
import { TokenResolverService } from '../../shared/token-resolver.service';

const BASE = 'https://clubgas-api.azurewebsites.net/api/v1';

/** Erro do axios com resposta HTTP, como o Clubgas devolve nas recusas. */
function erroHttp(status: number, data: unknown): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_REQUEST',
    undefined,
    undefined,
    { status, data } as AxiosResponse,
  );
}

describe('ClubgasClient', () => {
  const axiosGet = jest.spyOn(axios, 'get');
  const tokenResolver = {
    resolveClubgasToken: jest.fn(),
  };
  let client: ClubgasClient;

  const capturar = async (chamada: Promise<unknown>): Promise<ClubgasErro> => {
    const erro: unknown = await chamada.then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ClubgasErro);
    return erro as ClubgasErro;
  };

  const gerarCartao = () =>
    client.obterCartaoVirtual('HERTZ', {
      placa: 'ABC1D23',
      cpf: '12345678909',
    });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CLUBGAS_BASE_URL;
    tokenResolver.resolveClubgasToken.mockReturnValue('token-base');
    client = new ClubgasClient(
      tokenResolver as unknown as TokenResolverService,
    );
  });

  afterAll(() => axiosGet.mockRestore());

  it('envia os parâmetros da doc, com token por base e timeout', async () => {
    const cartao = { codCartao: 'Q073', isValid: true, errors: [] };
    axiosGet.mockResolvedValue({ status: 200, data: cartao });

    await expect(gerarCartao()).resolves.toEqual(cartao);

    expect(tokenResolver.resolveClubgasToken).toHaveBeenCalledWith('HERTZ');
    expect(axiosGet).toHaveBeenCalledWith(`${BASE}/CartaoClub/obter-virtual`, {
      params: { Placa: 'ABC1D23', Cpf: '12345678909' },
      timeout: 15_000,
      headers: { Authorization: 'Bearer token-base' },
    });
  });

  it('monta as chamadas de postos e de total economizado', async () => {
    axiosGet.mockResolvedValue({ status: 200, data: { result: [] } });
    await client.obterPostosMapa('HERTZ', {
      latitude: -22.9,
      longitude: -43.1,
      placa: 'ABC1D23',
    });
    expect(axiosGet).toHaveBeenLastCalledWith(
      `${BASE}/Posto/obter-map-app`,
      expect.objectContaining({
        params: { Latitude: -22.9, Longitude: -43.1, Placa: 'ABC1D23' },
      }),
    );

    process.env.TOKEN_API_CLUBGAS = 'token-legado';
    await client.obterTotalEconomizadoLegado('12345678909');
    expect(axiosGet).toHaveBeenLastCalledWith(
      `${BASE}/Aplicativo/total-economizado`,
      expect.objectContaining({
        params: { CpfCnpj: '12345678909' },
        headers: { Authorization: 'Bearer token-legado' },
      }),
    );
  });

  it.each([
    ['Dados inválidos.', 'DADOS_INVALIDOS'],
    [
      "Formato de placa inválido: Caractere inválido 'Z' na posição 4 para placa Mercosul. Esperado A-J.",
      'PLACA_INVALIDA',
    ],
    [
      'Não foi  possível gerar seu cartão virtual. Entre em contato com a entidade emissora do seu cartão.',
      'CARTAO_RECUSADO',
    ],
    ['Outra recusa qualquer', 'RECUSADO'],
  ])('classifica a recusa "%s" como %s', async (mensagem, categoria) => {
    const corpo = { isValid: false, errors: [mensagem] };
    axiosGet.mockRejectedValue(erroHttp(400, corpo));

    const erro = await capturar(gerarCartao());

    expect(erro).toMatchObject({
      operacao: 'CARTAO_VIRTUAL',
      categoria,
      httpStatus: 400,
      resposta: corpo,
    });
    // A mensagem do Clubgas é preservada (só normaliza espaços repetidos).
    expect(erro.message).toBe(mensagem.replace(/\s+/g, ' '));
  });

  it('classifica 5xx como erro do Clubgas, lendo `message`', async () => {
    axiosGet.mockRejectedValue(
      erroHttp(500, { isValid: false, message: 'Object reference not set' }),
    );

    const erro = await capturar(gerarCartao());

    expect(erro).toMatchObject({ categoria: 'ERRO_CLUBGAS', httpStatus: 500 });
    expect(erro.message).toBe('Object reference not set');
  });

  it('classifica timeout e falta de conexão, sem status HTTP', async () => {
    axiosGet.mockRejectedValue(
      new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED'),
    );
    expect(await capturar(gerarCartao())).toMatchObject({
      categoria: 'TIMEOUT',
      httpStatus: null,
      message: 'ECONNABORTED: timeout of 15000ms exceeded',
    });

    axiosGet.mockRejectedValue(
      new AxiosError('getaddrinfo ENOTFOUND clubgas', 'ENOTFOUND'),
    );
    expect(await capturar(gerarCartao())).toMatchObject({
      categoria: 'SEM_CONEXAO',
      httpStatus: null,
    });
  });

  it('trata 2xx com isValid=false ou sem corpo JSON como resposta inválida', async () => {
    axiosGet.mockResolvedValue({
      status: 200,
      data: { isValid: false, errors: [] },
    });
    expect(await capturar(gerarCartao())).toMatchObject({
      categoria: 'RESPOSTA_INVALIDA',
      httpStatus: 200,
    });

    axiosGet.mockResolvedValue({ status: 200, data: '' });
    expect(await capturar(gerarCartao())).toMatchObject({
      categoria: 'RESPOSTA_INVALIDA',
    });
  });

  it('não chama o Clubgas quando o token da base não está configurado', async () => {
    tokenResolver.resolveClubgasToken.mockImplementation(() => {
      throw new Error(
        'Environment variable TOKEN_API_CLUBGAS is not configured',
      );
    });

    const erro = await capturar(gerarCartao());

    expect(erro).toMatchObject({ categoria: 'CONFIGURACAO', httpStatus: null });
    expect(axiosGet).not.toHaveBeenCalled();
  });
});

describe('clubgasErroParaHttp', () => {
  const erro = (
    categoria: ClubgasErro['categoria'],
    mensagem = 'detalhe interno',
  ) => new ClubgasErro({ operacao: 'CARTAO_VIRTUAL', categoria, mensagem });

  it('devolve a mensagem do Clubgas em 422 nas recusas', () => {
    const http = clubgasErroParaHttp(
      erro('DADOS_INVALIDOS', 'Dados inválidos.'),
    );
    expect(http.getStatus()).toBe(422);
    expect(http.getResponse()).toEqual({
      statusCode: 422,
      code: 'CLUBGAS_DADOS_INVALIDOS',
      message: 'Dados inválidos.',
    });
  });

  it.each([
    ['TIMEOUT', 504],
    ['CONFIGURACAO', 503],
    ['ERRO_CLUBGAS', 502],
    ['SEM_CONEXAO', 502],
    ['RESPOSTA_INVALIDA', 502],
  ] as const)(
    'esconde o detalhe interno em %s (HTTP %i)',
    (categoria, status) => {
      const http = clubgasErroParaHttp(erro(categoria));
      expect(http.getStatus()).toBe(status);
      expect(http.getResponse()).toMatchObject({
        code: `CLUBGAS_${categoria}`,
        message: expect.stringContaining('indisponível'),
      });
    },
  );

  it('mantém o 404 de veículo sem placa', () => {
    const http = clubgasErroParaHttp(
      erro('VEICULO_SEM_PLACA', 'Placa não encontrada para o usuário'),
    );
    expect(http.getStatus()).toBe(404);
    expect(http.getResponse()).toMatchObject({
      statusCode: 404,
      message: 'Placa não encontrada para o usuário',
    });
  });
});

describe('postosRecusadosPelaPlaca', () => {
  it('reconhece a lista vazia sem paginação', () => {
    expect(postosRecusadosPelaPlaca({ result: [], pagination: null })).toBe(
      true,
    );
  });

  it('não acusa lista com postos nem lista vazia com paginação', () => {
    expect(
      postosRecusadosPelaPlaca({
        result: [{}],
        pagination: { totalElements: 1 },
      }),
    ).toBe(false);
    expect(
      postosRecusadosPelaPlaca({
        result: [],
        pagination: { totalElements: 0 },
      }),
    ).toBe(false);
    expect(postosRecusadosPelaPlaca({ result: [] })).toBe(false);
  });
});

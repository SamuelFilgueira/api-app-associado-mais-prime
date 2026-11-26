import { AxiosError } from 'axios';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { M7ReverseGeocodeService } from 'src/rastreamento/m7/services/m7-reverse-geocode.service';
import { HistoricoResumoService } from 'src/rastreamento/softruck/services/historico-resumo.service';
import { HistoricoProviderResolverService } from 'src/rastreamento/softruck/services/historico-provider-resolver.service';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import { LogicaHistoricoService } from 'src/rastreamento/logica/services/logica-historico.service';
import { prepararCredenciaisDeTeste } from 'src/rastreamento/testing/montar-rastreamento';
import { TokenResolverService } from 'src/shared/token-resolver.service';

function erroHttp(status: number, data: unknown = {}): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    undefined,
    undefined,
    { status, data, statusText: '', headers: {}, config: {} as never },
  );
}

/** JWT de mentira (sem assinatura) que vence em uma hora. */
function jwtDeTeste(): string {
  const parte = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${parte({ alg: 'none' })}.${parte({ exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
}

interface HttpSimulado {
  post: jest.Mock;
  get: jest.Mock;
}

function criarSoftruck(http: HttpSimulado): RastreamentoSoftruck {
  const servico = new RastreamentoSoftruck(
    new TokenResolverService(),
    {} as M7ReverseGeocodeService,
    VendorSessionStore.emMemoria(),
  );
  (servico as unknown as { axiosInstance: HttpSimulado }).axiosInstance = http;
  return servico;
}

type ErroHttpDoNest = {
  getStatus(): number;
  getResponse(): Record<string, unknown>;
};

describe('RastreamentoSoftruck — o que vai ao app nas falhas', () => {
  let restaurarAmbiente: () => void;
  let http: HttpSimulado;

  beforeEach(() => {
    restaurarAmbiente = prepararCredenciaisDeTeste();
    process.env.SOFTRUCK_API_BASE_URL = 'https://softruck.teste.local';
    http = {
      post: jest
        .fn()
        .mockResolvedValue({ data: { data: { token: jwtDeTeste() } } }),
      get: jest.fn(),
    };
  });

  afterEach(() => restaurarAmbiente());

  const consultar = (softruck: RastreamentoSoftruck) =>
    softruck
      .ultimaPosicaoSoftruck('CHASSI', 'MAIS_PRIME', 'chave', undefined, false)
      .catch((e: unknown) => e) as Promise<ErroHttpDoNest>;

  it('login recusado: 500 com mensagem neutra e code, sem o texto do vendor', async () => {
    http.post.mockRejectedValue(
      erroHttp(401, {
        error: { message: 'TEXTO CRU DO VENDOR: user blocked' },
      }),
    );

    const erro = await consultar(criarSoftruck(http));

    expect(erro.getStatus()).toBe(500);
    expect(erro.getResponse()).toEqual({
      statusCode: 500,
      message:
        'Rastreamento indisponível no momento. Tente novamente em instantes.',
      error: 'Internal Server Error',
      code: 'RASTREAMENTO_FALHA_DE_AUTENTICACAO',
    });
    expect(JSON.stringify(erro.getResponse())).not.toContain('VENDOR');
  });

  it('credenciais ausentes: 500 neutro, sem o nome das variáveis de ambiente', async () => {
    delete process.env.USERNAME_SOFTRUCK;

    const erro = await consultar(criarSoftruck(http));

    expect(erro.getStatus()).toBe(500);
    expect(erro.getResponse()).toMatchObject({
      code: 'RASTREAMENTO_NAO_CONFIGURADO',
    });
    expect(JSON.stringify(erro.getResponse())).not.toMatch(
      /USERNAME_SOFTRUCK|PASSWORD_SOFTRUCK/,
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  it('URL da API ausente: 500 neutro, sem o nome da variável', async () => {
    delete process.env.SOFTRUCK_API_BASE_URL;

    const erro = await consultar(criarSoftruck(http));

    expect(erro.getStatus()).toBe(500);
    expect(JSON.stringify(erro.getResponse())).not.toContain(
      'SOFTRUCK_API_BASE_URL',
    );
  });

  it('chassi inexistente continua com a mensagem e o status de sempre', async () => {
    http.get.mockResolvedValue({ data: { data: [] } });

    const erro = await consultar(criarSoftruck(http));

    expect(erro.getStatus()).toBe(500);
    expect(erro.getResponse()).toMatchObject({
      message: 'Veículo não encontrado na base Softruck',
    });
  });
});

describe('Histórico Softruck — dias que falharam não saem mais em silêncio', () => {
  let restaurarAmbiente: () => void;
  let http: HttpSimulado;
  let resumo: HistoricoResumoService;

  /** Resposta do by-keys por dia (`acc`): dados, 404 (sem viagens) ou falha. */
  let porDia: Record<number, 'dados' | 'sem_viagens' | 'falha' | 'timeout'>;

  const diaComDados = (acc: number) => ({
    data: {
      data: {
        id: `trajetoria-${acc}`,
        attributes: {
          acc,
          dur: 600,
          dis: 1000,
          spMax: 50,
          spAvg: 30,
          sgCnt: 1,
          stCnt: 0,
          stDur: 0,
          alCnt: 0,
          segs: [
            {
              id: `segmento-${acc}`,
              sta: { act: 1_780_000_000, lat: -22.9, lng: -43.2, adr: 'Rua A' },
              end: {
                act: 1_780_000_600,
                lat: -22.91,
                lng: -43.21,
                adr: 'Rua B',
              },
              dur: 600,
              dis: 1000,
              spMax: 50,
              spAvg: 30,
              stCnt: 0,
              stDur: 0,
              alCnt: 0,
            },
          ],
        },
        relationships: { enterprise: { id: 'empresa-1' } },
      },
    },
  });

  beforeEach(() => {
    restaurarAmbiente = prepararCredenciaisDeTeste();
    process.env.SOFTRUCK_API_BASE_URL = 'https://softruck.teste.local';
    porDia = {};
    http = {
      post: jest
        .fn()
        .mockResolvedValue({ data: { data: { token: jwtDeTeste() } } }),
      get: jest.fn(
        (_url: string, config: { params: Record<string, number> }) => {
          const acc = config.params['filters[acc][eq]'];
          switch (porDia[acc]) {
            case 'falha':
              return Promise.reject(erroHttp(503));
            case 'timeout':
              return Promise.reject(
                new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED'),
              );
            case 'sem_viagens':
              return Promise.reject(erroHttp(404));
            default:
              return Promise.resolve(diaComDados(acc));
          }
        },
      ),
    };
    const softruck = criarSoftruck(http);
    // O token precisa existir antes do by-keys (o fluxo real faz o login ao
    // resolver o veículo).
    (
      softruck as unknown as {
        softruckTokenByBase: Map<string, { token: string; expiresAt: number }>;
      }
    ).softruckTokenByBase.set('MAIS_PRIME', {
      token: jwtDeTeste(),
      expiresAt: Date.now() + 3_600_000,
    });
    resumo = new HistoricoResumoService(
      softruck,
      {
        resolve: () =>
          Promise.resolve({
            provider: 'softruck',
            vehicleData: {
              id: 'veiculo-1',
              plate: 'ABC1D23',
              brandName: 'FIAT',
              modelName: 'UNO',
            },
            deviceData: { vehicleId: 'veiculo-1', deviceId: 'dispositivo-1' },
          }),
      } as unknown as HistoricoProviderResolverService,
      {} as LogicaHistoricoService,
    );
  });

  afterEach(() => restaurarAmbiente());

  const consultar = () =>
    resumo.obterResumo(
      'CHASSI',
      '2026-08-01',
      '2026-08-04',
      'MAIS_PRIME',
      'chave',
    );

  it('período completo: parcial false, lista vazia e os demais campos como sempre', async () => {
    const resposta = await consultar();

    expect(resposta.parcial).toBe(false);
    expect(resposta.diasComFalha).toEqual([]);
    expect(Object.keys(resposta).sort()).toEqual(
      [
        'dias',
        'diasComFalha',
        'parcial',
        'period',
        'summary',
        'vehicle',
      ].sort(),
    );
    expect(resposta.dias).toHaveLength(4);
    expect(resposta.period).toEqual({
      dataInicial: '2026-08-01',
      dataFinal: '2026-08-04',
      totalDias: 4,
    });
  });

  it('dia com falha do provedor (5xx, timeout): 200 com parcial true e o dia listado', async () => {
    porDia[20260802] = 'falha';
    porDia[20260804] = 'timeout';

    const resposta = await consultar();

    expect(resposta.parcial).toBe(true);
    expect(resposta.diasComFalha).toEqual(['2026-08-02', '2026-08-04']);
    // Os dias que responderam continuam na resposta.
    expect(resposta.dias.map((d) => d.acc)).toEqual([20260801, 20260803]);
  });

  it('dia sem viagens (404 do provedor) não é falha', async () => {
    porDia[20260803] = 'sem_viagens';

    const resposta = await consultar();

    expect(resposta.parcial).toBe(false);
    expect(resposta.diasComFalha).toEqual([]);
    expect(resposta.dias).toHaveLength(3);
  });
});

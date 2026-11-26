import axios, { AxiosError } from 'axios';
import { VendorSessionStore } from 'src/integrations/core/vendor-session.store';
import { LogicaAuthService } from 'src/rastreamento/logica/services/logica-auth.service';
import { ProvedorLogica } from 'src/rastreamento/logica/services/logica-provedor';
import { LogicaRastreamentoService } from 'src/rastreamento/logica/services/rastreamento.logica';
import { M7AuthService } from 'src/rastreamento/m7/services/m7-auth.service';
import { ProvedorM7 } from 'src/rastreamento/m7/services/m7-provedor';
import { M7ReverseGeocodeService } from 'src/rastreamento/m7/services/m7-reverse-geocode.service';
import { RastreamentoM7 } from 'src/rastreamento/m7/services/rastreamento-m7';
import { ProvedorDeRastreamento } from 'src/rastreamento/providers/rastreamento-provider.interface';
import { RastreamentoSoftruck } from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import { SoftruckCredenciais } from 'src/rastreamento/softruck/services/softruck-credenciais';
import { ProvedorSoftruck } from 'src/rastreamento/softruck/services/softruck-provedor';
import { prepararCredenciaisDeTeste } from 'src/rastreamento/testing/montar-rastreamento';
import { TenantCredentialsRegistry } from 'src/shared/tenant/tenant-credentials.registry';
import { TokenResolverService } from 'src/shared/token-resolver.service';

/** Instante da posição usada em todos os cenários (fuso do processo). */
const INSTANTE = new Date(2026, 7, 31, 10, 0, 0).getTime();
const LATITUDE = -22.9;
const LONGITUDE = -43.2;
const CHASSI = '9BWZZZ377VT004251';
const CNPJ = '11222333000144';

type Situacao = 'ok' | 'nao_encontrado' | 'falha' | 'data_invalida';

function erroHttp(status: number): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    undefined,
    undefined,
    { status, data: {}, statusText: '', headers: {}, config: {} as never },
  );
}

/** JWT de mentira (sem assinatura) que vence em uma hora. */
function jwtDeTeste(): string {
  const parte = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${parte({ alg: 'none' })}.${parte({ exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
}

interface Cenario {
  nome: string;
  /** Variável de ambiente cuja falta deixa o provedor "não configurado". */
  credencial: string;
  /**
   * Cria o provedor de verdade (adaptador + client) sobre HTTP simulado.
   * `chamadas` lista o que foi pedido ao vendor; `credencialVista` devolve a
   * credencial da base que apareceu nas chamadas.
   */
  criar(situacao: () => Situacao): {
    provedor: ProvedorDeRastreamento;
    chamadas: () => string[];
    credencialVista: () => string | undefined;
  };
}

const CENARIOS: Cenario[] = [
  {
    nome: 'm7',
    credencial: 'MO7_TOKEN',
    criar(situacao) {
      const chamadas: string[] = [];
      let credencial: string | undefined;
      jest
        .spyOn(axios, 'post')
        .mockImplementation((url: string, corpo?: unknown) => {
          chamadas.push(url);
          if (url.endsWith('login')) {
            credencial = (corpo as { api_m7_token: string }).api_m7_token;
            return Promise.resolve({
              data: { sucesso: true, token: 'sessao-m7', expires_in: 3600 },
            });
          }
          switch (situacao()) {
            case 'nao_encontrado':
              return Promise.reject(erroHttp(404));
            case 'falha':
              return Promise.reject(erroHttp(500));
            default:
              return Promise.resolve({
                status: 200,
                data: {
                  ultima_posicao: {
                    monitorado: 10,
                    data_gps:
                      situacao() === 'data_invalida'
                        ? 'sem-data'
                        : '2026-08-31 10:00:00',
                    latitude: String(LATITUDE),
                    longitude: String(LONGITUDE),
                    velocidade: 40,
                    ignicao: true,
                    cidade: 'Rio de Janeiro,RJ',
                    marca: 'FIAT',
                    modelo: 'UNO',
                    identificador: 'ABC1D23',
                  },
                },
              });
          }
        });
      const auth = new M7AuthService(
        new TenantCredentialsRegistry(),
        VendorSessionStore.emMemoria(),
      );
      return {
        provedor: new ProvedorM7(new RastreamentoM7(auth), auth),
        chamadas: () => chamadas,
        credencialVista: () => credencial,
      };
    },
  },
  {
    nome: 'logica',
    credencial: 'LOGICA_TOKEN',
    criar(situacao) {
      const chamadas: string[] = [];
      let credencial: string | undefined;
      jest
        .spyOn(axios, 'post')
        .mockImplementation((url: string, corpo?: unknown) => {
          chamadas.push(url);
          credencial = (corpo as URLSearchParams).get('token') ?? undefined;
          switch (situacao()) {
            case 'nao_encontrado':
              return Promise.resolve({ data: { lista: [] } });
            case 'falha':
              return Promise.reject(erroHttp(500));
            default:
              return Promise.resolve({
                data: {
                  lista: [
                    {
                      oIgnicao: true,
                      placa: 'ABC1D23',
                      condutorNome: null,
                      modelo: 'UNO',
                      marca: 'FIAT',
                      alertaIgnicao: false,
                      ultimaPosicao: {
                        cidade: 'Rio de Janeiro',
                        endereco: 'Rua A',
                        numero: '10',
                        bairro: 'Centro',
                        estado: 'RJ',
                        latitude: LATITUDE,
                        longitude: LONGITUDE,
                        ultimaTrasmissao:
                          situacao() === 'data_invalida'
                            ? 'sem-data'
                            : '31/08/2026 10:00:00',
                        direcao: 'N',
                        ignicao: 'Ligada',
                        hodometro: 1000,
                        velocidade: 30,
                        voltagem: 12.1,
                      },
                    },
                  ],
                },
              });
          }
        });
      return {
        provedor: new ProvedorLogica(
          new LogicaRastreamentoService(
            new LogicaAuthService(VendorSessionStore.emMemoria()),
          ),
          new TenantCredentialsRegistry(),
        ),
        chamadas: () => chamadas,
        credencialVista: () => credencial,
      };
    },
  },
  {
    nome: 'softruck',
    credencial: 'PUBLIC_KEY_SOFTRUCK',
    criar(situacao) {
      const chamadas: string[] = [];
      let credencial: string | undefined;
      const anotar = (url: string, config?: { headers?: object }) => {
        chamadas.push(url);
        credencial =
          (config?.headers as Record<string, string> | undefined)?.[
            'public-key'
          ] ?? credencial;
      };
      const instancia = {
        post: jest.fn((url: string, _corpo: unknown, config?: object) => {
          anotar(url, config);
          return Promise.resolve({ data: { data: { token: jwtDeTeste() } } });
        }),
        get: jest.fn((url: string, config?: object) => {
          anotar(url, config);
          if (situacao() === 'falha') return Promise.reject(erroHttp(500));
          if (url.endsWith('/vehicles')) {
            return Promise.resolve({
              data: {
                data:
                  situacao() === 'nao_encontrado'
                    ? []
                    : [
                        {
                          id: 'veiculo-1',
                          attributes: {
                            plate: 'ABC1D23',
                            brand_name: 'FIAT',
                            model_name: 'UNO',
                          },
                        },
                      ],
              },
            });
          }
          if (url.endsWith('/associations/devices')) {
            return Promise.resolve({
              data: {
                data: [
                  {
                    id: 'associacao-1',
                    attributes: {
                      is_main_device: true,
                      created_at: '2026-01-01T00:00:00Z',
                      deleted_at: null,
                    },
                    relationships: { device: { id: 'dispositivo-1' } },
                  },
                ],
              },
            });
          }
          return Promise.resolve({
            data: {
              data: {
                attributes: {
                  ign: true,
                  act:
                    situacao() === 'data_invalida'
                      ? Number.NaN
                      : INSTANTE / 1000,
                  pv: 12.8,
                  spd: 55,
                  geometry: { coordinates: [LONGITUDE, LATITUDE] },
                },
              },
            },
          });
        }),
      };
      jest.spyOn(axios, 'create').mockReturnValue(instancia as never);
      const registry = new TenantCredentialsRegistry();
      const reverseGeocode = {
        normalizarCoordenada: () => null,
      } as unknown as M7ReverseGeocodeService;
      return {
        provedor: new ProvedorSoftruck(
          new RastreamentoSoftruck(
            new TokenResolverService(registry),
            reverseGeocode,
            VendorSessionStore.emMemoria(),
          ),
          new SoftruckCredenciais(registry),
          reverseGeocode,
        ),
        chamadas: () => chamadas,
        credencialVista: () => credencial,
      };
    },
  },
];

/**
 * Contrato de `ProvedorDeRastreamento`: o MESMO conjunto de testes roda
 * contra M7, Lógica e Softruck, cada um com o HTTP do vendor simulado.
 * Provedor novo entra na lista `CENARIOS` e tem de passar em tudo.
 */
describe.each(CENARIOS)('contrato de provedor — $nome', (cenario) => {
  let restaurarAmbiente: () => void;
  let situacao: Situacao;
  let provedor: ProvedorDeRastreamento;
  let chamadas: () => string[];
  let credencialVista: () => string | undefined;

  const consulta = (base = 'MAIS_PRIME') => ({
    base,
    chassi: CHASSI,
    cnpj: CNPJ,
  });

  function criar(semCredencial: string[] = []): void {
    restaurarAmbiente?.();
    restaurarAmbiente = prepararCredenciaisDeTeste(semCredencial);
    process.env.M7_API_BASE_URL = 'https://m7.teste.local/';
    process.env.LOGICA_API_BASE_URL = 'https://logica.teste.local';
    process.env.SOFTRUCK_API_BASE_URL = 'https://softruck.teste.local';
    // Credencial própria da base RS, para conferir que cada base usa a sua.
    process.env[`${cenario.credencial}_RS`] = 'credencial-da-base-rs';
    ({ provedor, chamadas, credencialVista } = cenario.criar(() => situacao));
  }

  beforeEach(() => {
    situacao = 'ok';
    criar();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restaurarAmbiente();
  });

  it('tem o nome estável que vai ao app e ao banco', () => {
    expect(provedor.nome).toBe(cenario.nome);
    expect(provedor.nome).toMatch(/^[a-z0-9]+$/);
  });

  it('está configurado quando a base tem a credencial dele', () => {
    expect(provedor.estaConfigurado('MAIS_PRIME')).toBe(true);
    expect(provedor.estaConfigurado('MAIS_PRIME_RS')).toBe(true);
  });

  it('não está configurado sem a credencial, e isso vale por base', () => {
    criar([cenario.credencial]);

    expect(provedor.estaConfigurado('MAIS_PRIME')).toBe(false);
    expect(provedor.estaConfigurado('MAIS_PRIME_RS')).toBe(true);
  });

  it('base que não é deste deploy: não configurado, sem lançar', () => {
    expect(provedor.estaConfigurado('OUTRA_EMPRESA')).toBe(false);
    expect(provedor.estaConfigurado(undefined as never)).toBe(false);
  });

  it('devolve a posição mais recente no envelope comum', async () => {
    const posicao = await provedor.obterUltimaPosicao(consulta());

    expect(posicao.origem).toBe(cenario.nome);
    expect(typeof posicao.dataDaPosicao).toBe('string');
    expect(posicao.timestamp).toBe(INSTANTE);
    expect(posicao.coordenadas).toEqual({
      latitude: LATITUDE,
      longitude: LONGITUDE,
    });
    // O corpo que vai ao app sempre traz a posição.
    expect(Number(posicao.resposta.latitude)).toBe(LATITUDE);
    expect(Number(posicao.resposta.longitude)).toBe(LONGITUDE);
  });

  it('resolve a própria credencial, a da base consultada', async () => {
    await provedor.obterUltimaPosicao(consulta('MAIS_PRIME_RS'));

    expect(credencialVista()).toBe('credencial-da-base-rs');
  });

  it('veículo que não existe no provedor → rejeita', async () => {
    situacao = 'nao_encontrado';

    await expect(provedor.obterUltimaPosicao(consulta())).rejects.toBeDefined();
  });

  it('falha do vendor → rejeita, sem credencial nem nome de variável na mensagem', async () => {
    situacao = 'falha';

    const erro = (await provedor
      .obterUltimaPosicao(consulta())
      .catch((e: unknown) => e)) as Error;

    expect(erro).toBeInstanceOf(Error);
    expect(erro.message).not.toContain('credencial-da-base-rs');
    expect(erro.message).not.toContain(cenario.credencial);
  });

  it('data que não é data → posição sem instante (fica fora da escolha), sem lançar', async () => {
    situacao = 'data_invalida';

    const posicao = await provedor.obterUltimaPosicao(consulta());

    expect(posicao.timestamp).toBeNull();
  });

  it('base sem a credencial dele → rejeita sem chamar a API de posição', async () => {
    criar([cenario.credencial]);

    await expect(provedor.obterUltimaPosicao(consulta())).rejects.toBeDefined();
    expect(chamadas().filter((url) => !/login$/.test(url))).toEqual([]);
  });
});

describe('contrato de provedor — conjunto', () => {
  it('os nomes dos provedores não se repetem', () => {
    const nomes = CENARIOS.map((c) => c.nome);

    expect(new Set(nomes).size).toBe(nomes.length);
  });
});

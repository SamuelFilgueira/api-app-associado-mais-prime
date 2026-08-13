import axios from 'axios';
import {
  montarLinhaDoTempo,
  parseDataBrParaTimestamp,
  TrajetosService,
} from 'src/rastreamento/logica/services/trajetos.service';
import {
  TrajetoParada,
  TrajetoPosicao,
} from 'src/rastreamento/logica/dto/trajeto.dto';
import { TrajetoPdfLogicaService } from 'src/rastreamento/logica/pdf/trajeto-pdf-logica.service';
import { LogicaAuthService } from 'src/rastreamento/logica/services/logica-auth.service';
import { LogicaRastreamentoService } from 'src/rastreamento/logica/services/rastreamento.logica';

jest.mock('axios');

const basePosicao: TrajetoPosicao = {
  tecladoEvento: null,
  eventoNome: null,
  enderecoNumero: '',
  enderecoEndereco: '',
  enderecoBairro: '',
  enderecoCidade: 'Belford Roxo',
  enderecoEstado: 'RJ',
  endereco: 'Rua Abiru 168 Barro Vermelho Belford Roxo RJ',
  data: '11/08/2026 00:41:03',
  dataTz: 0,
  latitude: -22.739493,
  longitude: -43.386076,
  velocidade: 0,
  direcao: 'NORTE',
  bateria: 12.5,
  bateriaEquipamento: 4.14,
  satelite: 15,
  ignicao: 'DESLIGADA',
  equipamentoId: 1077667,
  equipamentoCodigo: '0862667085433137',
  veiculoId: 1325811,
  placa: 'KXC9D02',
  motoristaNome: null,
  entradas: '0;null;0',
  saidas: '0;0',
  portaEntrada: '',
  portaSaida: '',
  imagem: '',
  id: 1,
  i: 1,
};

function fabricarPosicao(dados: Partial<TrajetoPosicao>): TrajetoPosicao {
  return { ...basePosicao, ...dados };
}

function fabricarParada(dados: Partial<TrajetoParada>): TrajetoParada {
  return {
    ...basePosicao,
    tipo: 'Parada',
    dataInicio: basePosicao.data,
    dataFim: basePosicao.data,
    tempo: '00:00:00',
    latitudeFim: null,
    longitudeFim: null,
    enderecoNumeroFim: '',
    enderecoEnderecoFim: '',
    enderecoBairroFim: '',
    enderecoCidadeFim: '',
    enderecoEstadoFim: '',
    ...dados,
  };
}

describe('parseDataBrParaTimestamp', () => {
  it('converte data BR em timestamp ordenável', () => {
    const antes = parseDataBrParaTimestamp('11/08/2026 00:02:04');
    const depois = parseDataBrParaTimestamp('11/08/2026 08:29:14');
    expect(antes).toBeLessThan(depois);
  });

  it('aceita data sem segundos', () => {
    expect(parseDataBrParaTimestamp('11/08/2026 08:29')).toBe(
      parseDataBrParaTimestamp('11/08/2026 08:29:00'),
    );
  });

  it('manda datas inválidas para o fim da linha do tempo', () => {
    expect(parseDataBrParaTimestamp('')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseDataBrParaTimestamp('data-invalida')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe('montarLinhaDoTempo', () => {
  it('mescla paradas e posições em ordem cronológica', () => {
    const posicoes = [
      fabricarPosicao({ data: '11/08/2026 08:29:14', latitude: -22.732493 }),
    ];
    const paradas = [
      fabricarParada({
        dataInicio: '11/08/2026 00:02:04',
        latitude: -22.739493,
      }),
      fabricarParada({
        dataInicio: '11/08/2026 09:41:05',
        latitude: -22.709509,
      }),
    ];

    const resultado = montarLinhaDoTempo(posicoes, paradas);

    expect(resultado.map((ponto) => ponto.data)).toEqual([
      '11/08/2026 00:02:04',
      '11/08/2026 08:29:14',
      '11/08/2026 09:41:05',
    ]);
  });

  it('usa dataInicio da parada como data da linha', () => {
    const paradas = [
      fabricarParada({
        data: '11/08/2026 08:07:27',
        dataInicio: '11/08/2026 08:07:27',
        endereco: 'Rua Célia Barcelos 61 Nova Piam Belford Roxo RJ',
      }),
    ];

    const [linha] = montarLinhaDoTempo([], paradas);

    expect(linha.data).toBe('11/08/2026 08:07:27');
    expect(linha.endereco).toBe(
      'Rua Célia Barcelos 61 Nova Piam Belford Roxo RJ',
    );
  });

  it('deduplica registros com mesma data e coordenadas', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 08:52:54',
        latitude: -22.76332,
        longitude: -43.303538,
      }),
    ];
    const paradas = [
      fabricarParada({
        dataInicio: '11/08/2026 08:52:54',
        latitude: -22.76332,
        longitude: -43.303538,
      }),
    ];

    expect(montarLinhaDoTempo(posicoes, paradas)).toHaveLength(1);
  });

  it('preenche ignição vazia com o último estado conhecido', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 08:29:14',
        latitude: -22.732493,
        ignicao: '',
        bateria: 0,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:29:18',
        latitude: -22.733338,
        ignicao: 'DESLIGADA',
      }),
    ];
    const paradas = [
      fabricarParada({
        dataInicio: '11/08/2026 00:02:04',
        latitude: -22.739493,
        ignicao: 'DESLIGADA',
      }),
    ];

    const resultado = montarLinhaDoTempo(posicoes, paradas);

    expect(resultado.map((ponto) => ponto.ignicao)).toEqual([
      'DESLIGADA',
      'DESLIGADA',
      'DESLIGADA',
    ]);
  });

  it('mantém ignição vazia quando não há estado anterior conhecido', () => {
    const posicoes = [
      fabricarPosicao({ data: '11/08/2026 00:41:03', ignicao: '' }),
      fabricarPosicao({
        data: '11/08/2026 08:29:18',
        latitude: -22.733338,
        ignicao: 'LIGADA',
      }),
    ];

    const resultado = montarLinhaDoTempo(posicoes, []);

    expect(resultado[0].ignicao).toBe('');
    expect(resultado[1].ignicao).toBe('LIGADA');
  });
});

describe('autenticação na Lógica (retry + dedupe)', () => {
  const axiosMock = axios as jest.Mocked<typeof axios>;
  const envOriginal = { ...process.env };

  function fabricarService(): TrajetosService {
    return new TrajetosService(
      {} as unknown as TrajetoPdfLogicaService,
      new LogicaAuthService(),
    );
  }

  /**
   * Mock da API: /listaVeiculo recusa o token até um login bem-sucedido;
   * /autentica recusa as N primeiras tentativas (comportamento do throttle
   * observado em produção: HTTP 200 com erro=true e token vazio).
   */
  function configurarApi(recusasAutentica: number) {
    let tentativasAutentica = 0;
    let logado = false;

    axiosMock.post.mockImplementation((url: unknown) => {
      const destino = String(url);

      if (destino.endsWith('/autentica')) {
        tentativasAutentica++;
        if (tentativasAutentica <= recusasAutentica) {
          return Promise.resolve({
            status: 200,
            data: { erro: true, logado: false, token: '', mensagem: '' },
          });
        }
        logado = true;
        return Promise.resolve({
          status: 200,
          data: { erro: false, logado: true, token: 'token-renovado' },
        });
      }

      if (destino.endsWith('/listaVeiculo')) {
        if (!logado) {
          return Promise.resolve({
            status: 200,
            data: { erro: true, logado: false },
          });
        }
        return Promise.resolve({
          status: 200,
          data: {
            lista: [
              {
                id: 1325811,
                chassi: 'CHASSI-LOGICA-1',
                placa: 'KXC9D02',
                marca: 'Fiat',
                modelo: 'Uno',
              },
            ],
          },
        });
      }

      return Promise.resolve({ status: 200, data: {} });
    });
  }

  function chamadasPara(sufixo: string): number {
    return axiosMock.post.mock.calls.filter(([url]) =>
      String(url).endsWith(sufixo),
    ).length;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOGICA_API_BASE_URL = 'https://logica.test/mobile';
    process.env.LOGICA_API_NUMBER = '9999';
    process.env.LOGICA_TOKEN = 'token-env-expirado';
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...envOriginal };
  });

  it('renova o token com retry quando a Lógica recusa logins em rajada', async () => {
    configurarApi(2);
    jest.useFakeTimers();

    const service = fabricarService();
    const promessa = service.buscarVeiculoPorChassi(
      'CHASSI-LOGICA-1',
      'MAIS_PRIME',
    );

    await jest.runAllTimersAsync();
    const veiculo = await promessa;

    expect(veiculo).toEqual({
      id: 1325811,
      placa: 'KXC9D02',
      marca: 'Fiat',
      modelo: 'Uno',
    });
    expect(chamadasPara('/autentica')).toBe(3);
  });

  it('lança erro com a mensagem original após esgotar as tentativas', async () => {
    configurarApi(Number.MAX_SAFE_INTEGER);
    jest.useFakeTimers();

    const service = fabricarService();
    const promessa = service.buscarVeiculoPorChassi(
      'CHASSI-LOGICA-1',
      'MAIS_PRIME',
    );
    const expectativa = expect(promessa).rejects.toThrow(
      'Falha ao autenticar na API Lógica para renovação de token',
    );

    await jest.runAllTimersAsync();
    await expectativa;

    expect(chamadasPara('/autentica')).toBe(4);
  });

  it('deduplica logins paralelos: chamadas simultâneas compartilham um único /autentica', async () => {
    configurarApi(0);

    const service = fabricarService();
    const [veiculoA, veiculoB] = await Promise.all([
      service.buscarVeiculoPorChassi('CHASSI-LOGICA-1', 'MAIS_PRIME'),
      service.buscarVeiculoPorChassi('CHASSI-LOGICA-1', 'MAIS_PRIME'),
    ]);

    expect(veiculoA?.id).toBe(1325811);
    expect(veiculoB?.id).toBe(1325811);
    expect(chamadasPara('/autentica')).toBe(1);
  });

  it('usa o token cacheado após a renovação, sem novo login', async () => {
    configurarApi(0);

    const service = fabricarService();
    await service.buscarVeiculoPorChassi('CHASSI-LOGICA-1', 'MAIS_PRIME');
    await service.buscarVeiculoPorChassi('CHASSI-LOGICA-1', 'MAIS_PRIME');

    expect(chamadasPara('/autentica')).toBe(1);
  });

  it('compartilha a sessão entre rastreamento em tempo real e histórico (um único login)', async () => {
    configurarApi(0);

    const auth = new LogicaAuthService();
    const rastreamento = new LogicaRastreamentoService(auth);
    const trajetos = new TrajetosService(
      {} as unknown as TrajetoPdfLogicaService,
      auth,
    );

    // Fluxo do app: primeiro a tela de rastreamento (última posição)...
    await rastreamento.ultimaPosicao('CHASSI-LOGICA-1', 'token-env-expirado', {
      baseOrigin: 'MAIS_PRIME',
    });
    // ...depois o usuário abre as rotas/histórico
    const veiculo = await trajetos.buscarVeiculoPorChassi(
      'CHASSI-LOGICA-1',
      'MAIS_PRIME',
    );

    expect(veiculo?.id).toBe(1325811);
    expect(chamadasPara('/autentica')).toBe(1);
  });
});

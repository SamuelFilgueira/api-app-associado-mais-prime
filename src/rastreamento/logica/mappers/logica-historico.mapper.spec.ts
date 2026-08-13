import {
  enriquecerEnderecosComParadas,
  epochParaAcc,
  formatarActIso,
  mapearResumoDias,
  mapearRotasFeatures,
  mapearSegmentosHistorico,
  mapearVehicleInfo,
  parseDataBrParaEpochSeconds,
  parseDataLogicaParaEpochSeconds,
  segmentarViagens,
} from 'src/rastreamento/logica/mappers/logica-historico.mapper';
import {
  TrajetoParada,
  TrajetoPosicao,
  TrajetoRelatorio,
  TrajetoResumo,
} from 'src/rastreamento/logica/dto/trajeto.dto';

// ============================================================
// Fábricas de dados (baseadas no retorno real de 11/08/2026)
// ============================================================

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

function fabricarRelatorio(
  paradas: TrajetoParada[],
  posicoes: TrajetoPosicao[],
): TrajetoRelatorio {
  return {
    paradas,
    posicoes,
    resumo: null as unknown as TrajetoResumo,
    eventoMotorista: [],
  };
}

const END_ABIRU = 'Rua Abiru 168 Barro Vermelho Belford Roxo RJ';
const END_CELIA = 'Rua Célia Barcelos 71 Barro Vermelho Belford Roxo RJ';
const END_BENJAMIN = 'Avenida Benjamin Pinto Dias 643 Centro Belford Roxo RJ';

/**
 * Trilha realista (só posições — o algoritmo ignora paradas[]):
 * pernoite na Rua Abiru, deslocamento curto até a Rua Célia Barcelos
 * (começando DENTRO da parada, com fix em movimento de coordenada congelada),
 * segunda parada e deslocamento longo até a Av. Benjamin Pinto Dias.
 */
function fabricarPosicoesReais(): TrajetoPosicao[] {
  return [
    // Parada 1 (pernoite na Rua Abiru)
    fabricarPosicao({
      data: '11/08/2026 00:02:04',
      velocidade: 0,
      latitude: -22.739493,
      longitude: -43.386076,
      endereco: END_ABIRU,
    }),
    fabricarPosicao({
      data: '11/08/2026 07:30:00',
      velocidade: 0,
      latitude: -22.739493,
      longitude: -43.386076,
      endereco: END_ABIRU,
    }),
    // Fix em movimento com coordenada congelada — ainda dentro da parada,
    // mas é o INÍCIO do deslocamento (comportamento do relatório oficial)
    fabricarPosicao({
      data: '11/08/2026 08:05:59',
      velocidade: 17,
      latitude: -22.739493,
      longitude: -43.386076,
      endereco: END_ABIRU,
    }),
    // Primeira posição em movimento com coordenada diferente (fim da parada 1)
    fabricarPosicao({
      data: '11/08/2026 08:06:30',
      velocidade: 19,
      latitude: -22.7385,
      longitude: -43.385,
    }),
    fabricarPosicao({
      data: '11/08/2026 08:07:00',
      velocidade: 15,
      latitude: -22.738,
      longitude: -43.384,
    }),
    // Parada 2 (Rua Célia Barcelos) — fim do deslocamento 1
    fabricarPosicao({
      data: '11/08/2026 08:07:27',
      velocidade: 0,
      latitude: -22.737512,
      longitude: -43.383153,
      endereco: END_CELIA,
    }),
    fabricarPosicao({
      data: '11/08/2026 08:09:00',
      velocidade: 0,
      latitude: -22.737512,
      longitude: -43.383153,
      endereco: END_CELIA,
    }),
    // Início do deslocamento 2 (fim da parada 2)
    fabricarPosicao({
      data: '11/08/2026 08:10:43',
      velocidade: 22,
      latitude: -22.735,
      longitude: -43.38,
    }),
    // Posição real do sample, com dataTz em epoch MS e ignição inconsistente
    fabricarPosicao({
      data: '11/08/2026 08:29:14',
      dataTz: 1786447754000,
      velocidade: 38,
      latitude: -22.732493,
      longitude: -43.350689,
      ignicao: '',
      endereco: 'Avenida Joaquim da Costa Lima 2460 Maringá Belford Roxo RJ',
    }),
    // Parada 3 (Av. Benjamin Pinto Dias) — fim do deslocamento 2
    fabricarPosicao({
      data: '11/08/2026 11:07:47',
      velocidade: 0,
      latitude: -22.766744,
      longitude: -43.399347,
      endereco: END_BENJAMIN,
    }),
    fabricarPosicao({
      data: '11/08/2026 11:20:00',
      velocidade: 0,
      latitude: -22.766744,
      longitude: -43.399347,
      endereco: END_BENJAMIN,
    }),
  ];
}

function fabricarRelatorioReal(): TrajetoRelatorio {
  return fabricarRelatorio([], fabricarPosicoesReais());
}

// ============================================================
// Conversão de data/hora
// ============================================================

describe('parseDataBrParaEpochSeconds', () => {
  it('converte data BR para epoch real em segundos (validado pelo dataTz do sample)', () => {
    // A posição real "11/08/2026 08:29:14" veio com dataTz = 1786447754000 ms
    expect(parseDataBrParaEpochSeconds('11/08/2026 08:29:14')).toBe(1786447754);
  });

  it('aceita data sem segundos', () => {
    expect(parseDataBrParaEpochSeconds('11/08/2026 08:29')).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 08:29:00'),
    );
  });

  it('retorna null para datas inválidas', () => {
    expect(parseDataBrParaEpochSeconds('')).toBeNull();
    expect(parseDataBrParaEpochSeconds('data-invalida')).toBeNull();
    expect(parseDataBrParaEpochSeconds('2026-08-11 08:29:14')).toBeNull();
  });
});

describe('parseDataLogicaParaEpochSeconds', () => {
  it('aceita o formato BR do /mobile/trajeto', () => {
    expect(parseDataLogicaParaEpochSeconds('11/08/2026 08:29:14')).toBe(
      1786447754,
    );
  });

  it('aceita o formato do /mobile/posicao (yyyy-MM-dd HH:mm:ss.SSS)', () => {
    expect(parseDataLogicaParaEpochSeconds('2026-08-11 08:29:14.933')).toBe(
      1786447754,
    );
    expect(parseDataLogicaParaEpochSeconds('2026-08-11 08:29:14')).toBe(
      1786447754,
    );
  });

  it('retorna null para datas inválidas', () => {
    expect(parseDataLogicaParaEpochSeconds('')).toBeNull();
    expect(parseDataLogicaParaEpochSeconds('nada')).toBeNull();
  });
});

describe('formatarActIso', () => {
  it('formata epoch como ISO 8601 com offset -03:00', () => {
    expect(formatarActIso(1786447754)).toBe('2026-08-11T08:29:14-03:00');
  });

  it('é a inversa exata do parse (garante o filtro resumo↔rotas do app)', () => {
    const epoch = parseDataBrParaEpochSeconds('11/08/2026 08:05:59')!;
    const iso = formatarActIso(epoch);

    // O app faz new Date(inicio.act).getTime() / 1000 e compara com point.act
    expect(new Date(iso).getTime() / 1000).toBe(epoch);
  });
});

describe('epochParaAcc', () => {
  it('retorna o dia local YYYYMMDD no fuso -03:00', () => {
    expect(epochParaAcc(1786447754)).toBe(20260811);
  });

  it('usa o dia local, não o dia UTC, perto da meia-noite', () => {
    // 11/08/2026 23:30:00 -03:00 = 12/08/2026 02:30:00 UTC
    const epoch = parseDataBrParaEpochSeconds('11/08/2026 23:30:00')!;
    expect(epochParaAcc(epoch)).toBe(20260811);
  });
});

// ============================================================
// Segmentação de deslocamentos (algoritmo da plataforma da Lógica)
// ============================================================

describe('segmentarViagens', () => {
  it('recorta deslocamentos entre paradas usando somente as posições', () => {
    const viagens = segmentarViagens(fabricarRelatorioReal());

    expect(viagens).toHaveLength(2);

    const [v1, v2] = viagens;

    expect(v1.inicioTs).toBe(parseDataBrParaEpochSeconds('11/08/2026 08:05:59'));
    expect(v1.fimTs).toBe(parseDataBrParaEpochSeconds('11/08/2026 08:07:27'));
    expect(v1.inicioEndereco).toBe(END_ABIRU);
    expect(v1.fimEndereco).toBe(END_CELIA);
    expect(v1.duracaoSegundos).toBe(88);
    // Métricas em [inicio, fim): 17, 19, 15
    expect(v1.velocidadeMedia).toBe(17);
    expect(v1.velocidadeMaxima).toBe(19);
    expect(v1.distanciaMetros).toBeGreaterThan(0);

    expect(v2.inicioTs).toBe(parseDataBrParaEpochSeconds('11/08/2026 08:10:43'));
    expect(v2.fimTs).toBe(parseDataBrParaEpochSeconds('11/08/2026 11:07:47'));
    expect(v2.fimEndereco).toBe(END_BENJAMIN);
    expect(v2.velocidadeMaxima).toBe(38);
  });

  it('o deslocamento começa no primeiro fix em movimento, mesmo DENTRO da parada', () => {
    const [v1] = segmentarViagens(fabricarRelatorioReal());

    // O fix de 08:05:59 (vel 17, coordenada congelada) ainda pertence à
    // parada — que só termina em 08:06:30 — mas é o início do deslocamento
    expect(v1.inicioTs).toBe(parseDataBrParaEpochSeconds('11/08/2026 08:05:59'));
    expect(v1.inicioTs).toBeLessThan(
      parseDataBrParaEpochSeconds('11/08/2026 08:06:30')!,
    );
    expect(v1.inicioLat).toBe(-22.739493);
    expect(v1.inicioLng).toBe(-43.386076);
  });

  it('ignora completamente o array paradas[] da API', () => {
    const posicoes = fabricarPosicoesReais();

    // Paradas absurdas que fragmentariam/engoliriam os deslocamentos se usadas
    const paradasInconsistentes = [
      fabricarParada({
        dataInicio: '11/08/2026 08:06:00',
        dataFim: '11/08/2026 10:00:00',
        latitude: -22.7385,
        longitude: -43.385,
      }),
      fabricarParada({
        dataInicio: '11/08/2026 00:00:00',
        dataFim: '11/08/2026 23:59:00',
        latitude: -22.75,
        longitude: -43.4,
      }),
    ];

    const comParadas = segmentarViagens(
      fabricarRelatorio(paradasInconsistentes, posicoes),
    );
    const semParadas = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(comParadas).toEqual(semParadas);
    expect(comParadas).toHaveLength(2);
  });

  it('zeros intermediários entram na média de velocidade (caso 5 do relatório oficial)', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 10:15:00',
        velocidade: 0,
        latitude: -22.75,
        longitude: -43.4,
      }),
      // Fixes com coordenada congelada dentro da parada (velocidades 12, 0, 11)
      fabricarPosicao({
        data: '11/08/2026 10:19:13',
        velocidade: 12,
        latitude: -22.75,
        longitude: -43.4,
      }),
      fabricarPosicao({
        data: '11/08/2026 10:20:00',
        velocidade: 0,
        latitude: -22.75,
        longitude: -43.4,
      }),
      fabricarPosicao({
        data: '11/08/2026 10:20:30',
        velocidade: 11,
        latitude: -22.75,
        longitude: -43.4,
      }),
      // Primeiro fix em movimento com coordenada diferente (fim da parada)
      fabricarPosicao({
        data: '11/08/2026 10:21:00',
        velocidade: 9,
        latitude: -22.7495,
        longitude: -43.4,
      }),
      // Parada seguinte — fim do deslocamento
      fabricarPosicao({
        data: '11/08/2026 10:21:43',
        velocidade: 0,
        latitude: -22.749,
        longitude: -43.4,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    expect(viagens[0].inicioTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 10:19:13'),
    );
    expect(viagens[0].fimTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 10:21:43'),
    );
    expect(viagens[0].duracaoSegundos).toBe(150); // 00:02:30
    // Intervalo [inicio, fim) contém 12, 0, 11, 9 → média 8.00 (zero incluído)
    expect(viagens[0].velocidadeMedia).toBe(8);
  });

  it('a distância se estende do último ponto da parada anterior ao primeiro da seguinte (caso 1)', () => {
    // Passos de ~200 m em latitude
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 08:00:00',
        velocidade: 0,
        latitude: -22.74,
        longitude: -43.386,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:05:00',
        velocidade: 0,
        latitude: -22.74,
        longitude: -43.386,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:05:30',
        velocidade: 20,
        latitude: -22.7382,
        longitude: -43.386,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:06:00',
        velocidade: 20,
        latitude: -22.7364,
        longitude: -43.386,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:06:30',
        velocidade: 0,
        latitude: -22.7346,
        longitude: -43.386,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    // Somente os pontos em movimento dariam ~200 m; com as pontas das
    // paradas vizinhas o total é ~600 m
    expect(viagens[0].distanciaMetros).toBeGreaterThan(580);
    expect(viagens[0].distanciaMetros).toBeLessThan(620);
  });

  it('não aplica filtro de duração/distância mínima (caso 3: 31 s são emitidos)', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 08:30:00',
        velocidade: 0,
        latitude: -22.73,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:31:30',
        velocidade: 17,
        latitude: -22.7297,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:32:01',
        velocidade: 0,
        latitude: -22.7295,
        longitude: -43.38,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    expect(viagens[0].duracaoSegundos).toBe(31);
  });

  it('trilha completa sem simplificação, com o ponto-âncora dentro da janela do app', () => {
    const [v1] = segmentarViagens(fabricarRelatorioReal());

    // Âncora (último fix da parada) + 3 fixes do intervalo + ponto da parada
    // seguinte = 5 pontos, nenhum descartado
    expect(v1.pontos).toHaveLength(5);

    // O âncora real é de 07:30:00, mas o ts é grampeado ao início do
    // deslocamento para cair na janela [inicio.act, fim.act] usada pelo app
    expect(v1.pontos[0].ts).toBe(v1.inicioTs);
    expect(v1.pontos[0].lat).toBe(-22.739493);
    expect(v1.pontos[v1.pontos.length - 1].ts).toBe(v1.fimTs);
    expect(v1.pontos[v1.pontos.length - 1].lat).toBe(-22.737512);
  });

  it('movimento após a última parada vira deslocamento de borda', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 08:00:00',
        velocidade: 0,
        latitude: -22.73,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '11/08/2026 09:00:00',
        velocidade: 0,
        latitude: -22.73,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '11/08/2026 09:01:00',
        velocidade: 30,
        latitude: -22.735,
        longitude: -43.385,
      }),
      fabricarPosicao({
        data: '11/08/2026 09:05:00',
        velocidade: 40,
        latitude: -22.74,
        longitude: -43.39,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    expect(viagens[0].inicioTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 09:01:00'),
    );
    expect(viagens[0].fimTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 09:05:00'),
    );
  });

  it('movimento antes da primeira parada vira deslocamento de borda', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 07:50:00',
        velocidade: 35,
        latitude: -22.72,
        longitude: -43.37,
      }),
      fabricarPosicao({
        data: '11/08/2026 07:55:00',
        velocidade: 20,
        latitude: -22.725,
        longitude: -43.375,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:00:00',
        velocidade: 0,
        latitude: -22.73,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '11/08/2026 09:00:00',
        velocidade: 0,
        latitude: -22.73,
        longitude: -43.38,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    expect(viagens[0].inicioTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 07:50:00'),
    );
    expect(viagens[0].fimTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 08:00:00'),
    );
  });

  it('trilha inteira em movimento vira um único deslocamento', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 10:00:00',
        velocidade: 30,
        latitude: -22.73,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '11/08/2026 10:05:00',
        velocidade: 45,
        latitude: -22.735,
        longitude: -43.385,
      }),
      fabricarPosicao({
        data: '11/08/2026 10:10:00',
        velocidade: 40,
        latitude: -22.74,
        longitude: -43.39,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    expect(viagens[0].inicioTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 10:00:00'),
    );
    expect(viagens[0].fimTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 10:10:00'),
    );
  });

  it('dia inteiro parado retorna lista vazia (não erro)', () => {
    const posicoes = ['08:00:00', '12:00:00', '18:00:00'].map((hora) =>
      fabricarPosicao({
        data: `11/08/2026 ${hora}`,
        velocidade: 0,
        latitude: -22.739493,
        longitude: -43.386076,
      }),
    );

    expect(segmentarViagens(fabricarRelatorio([], posicoes))).toHaveLength(0);
  });

  it('descarta posições sem coordenadas antes de processar', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 08:00:00',
        velocidade: 0,
        latitude: -22.73,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:02:00',
        velocidade: 50,
        latitude: null as unknown as number,
        longitude: null as unknown as number,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:05:00',
        velocidade: 30,
        latitude: -22.735,
        longitude: -43.385,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:10:00',
        velocidade: 0,
        latitude: -22.74,
        longitude: -43.39,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    // A posição inválida não pode ter virado o início do deslocamento
    expect(viagens[0].inicioTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 08:05:00'),
    );
  });

  it('retorna vazio para relatório sem dados', () => {
    expect(segmentarViagens(fabricarRelatorio([], []))).toHaveLength(0);
  });

  it('descarta fixes com posicaoValida=false (sem sinal de GPS)', () => {
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 08:00:00',
        velocidade: 0,
        latitude: -22.73,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:05:00',
        velocidade: 30,
        latitude: -22.735,
        longitude: -43.385,
      }),
      // Parada "fantasma" no meio do trajeto composta só de fixes inválidos —
      // a plataforma as descarta, então NÃO pode virar fronteira
      fabricarPosicao({
        data: '11/08/2026 08:06:00',
        velocidade: 0,
        latitude: -22.7355,
        longitude: -43.3855,
        posicaoValida: false,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:06:30',
        velocidade: 0,
        latitude: -22.7355,
        longitude: -43.3855,
        posicaoValida: false,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:08:00',
        velocidade: 35,
        latitude: -22.74,
        longitude: -43.39,
      }),
      fabricarPosicao({
        data: '11/08/2026 08:10:00',
        velocidade: 0,
        latitude: -22.745,
        longitude: -43.395,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    // Sem o filtro, os zeros inválidos quebrariam o trajeto em dois
    expect(viagens).toHaveLength(1);
    expect(viagens[0].fimTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 08:10:00'),
    );
  });

  it('atravessa paradas sem deslocamento real (fixes congelados na mesma coordenada)', () => {
    // Cenário real do relatório: o veículo "liga" mas não sai do lugar; a
    // parada seguinte (mesmo local) não é fronteira — o deslocamento vai até
    // a primeira parada em local diferente
    const posicoes = [
      // Parada A
      fabricarPosicao({
        data: '11/08/2026 17:33:06',
        velocidade: 0,
        latitude: -22.74063,
        longitude: -43.39021,
      }),
      // Fix "em movimento" com coordenada congelada num ponto novo
      fabricarPosicao({
        data: '11/08/2026 17:34:39',
        velocidade: 10,
        latitude: -22.740636,
        longitude: -43.390222,
      }),
      // Parada B — MESMA coordenada do fix acima → não é fronteira
      fabricarPosicao({
        data: '11/08/2026 17:35:06',
        velocidade: 0,
        latitude: -22.740636,
        longitude: -43.390222,
      }),
      // Movimento real
      fabricarPosicao({
        data: '11/08/2026 17:36:38',
        velocidade: 14,
        latitude: -22.741147,
        longitude: -43.390298,
      }),
      fabricarPosicao({
        data: '11/08/2026 17:37:56',
        velocidade: 10,
        latitude: -22.739598,
        longitude: -43.388351,
      }),
      // Parada C — local diferente → fronteira de verdade
      fabricarPosicao({
        data: '11/08/2026 17:38:28',
        velocidade: 0,
        latitude: -22.739598,
        longitude: -43.388351,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    expect(viagens[0].inicioTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 17:34:39'),
    );
    expect(viagens[0].fimTs).toBe(
      parseDataBrParaEpochSeconds('11/08/2026 17:38:28'),
    );
    // Média inclui os zeros do trecho congelado: (10+0+14+10)/4 = 8.5
    expect(viagens[0].velocidadeMedia).toBe(8.5);
  });

  it('segmenta posições no formato do /mobile/posicao (data ISO, sem dataTz)', () => {
    const posicoes = [
      fabricarPosicao({
        data: '2026-08-11 08:00:00.933',
        velocidade: 0,
        latitude: -22.73,
        longitude: -43.38,
      }),
      fabricarPosicao({
        data: '2026-08-11 08:05:30.101',
        velocidade: 20,
        latitude: -22.735,
        longitude: -43.385,
      }),
      fabricarPosicao({
        data: '2026-08-11 08:06:30.500',
        velocidade: 0,
        latitude: -22.74,
        longitude: -43.39,
      }),
    ];

    const viagens = segmentarViagens(fabricarRelatorio([], posicoes));

    expect(viagens).toHaveLength(1);
    expect(viagens[0].inicioTs).toBe(
      parseDataLogicaParaEpochSeconds('2026-08-11 08:05:30'),
    );
    expect(viagens[0].fimTs).toBe(
      parseDataLogicaParaEpochSeconds('2026-08-11 08:06:30'),
    );
  });
});

// ============================================================
// Enriquecimento de endereços via paradas[]
// ============================================================

describe('enriquecerEnderecosComParadas', () => {
  const END_UMBELINA = 'Rua Umbelina Barcelos 169 Nova Piam Belford Roxo RJ';

  function fabricarViagens() {
    // Posições sem endereço (cenário /mobile/posicao). O veículo dorme na
    // Rua Abiru, mas o 1º fix em movimento já sai uma quadra depois, perto
    // da Rua Umbelina Barcelos — como no dado real.
    const posicoes = [
      fabricarPosicao({
        data: '11/08/2026 08:00:00',
        velocidade: 0,
        latitude: -22.739493,
        longitude: -43.386076,
        endereco: '',
      }),
      // 1º fix em movimento, ~300 m do ponto de estacionamento
      fabricarPosicao({
        data: '11/08/2026 08:05:59',
        velocidade: 17,
        latitude: -22.736869,
        longitude: -43.387067,
        endereco: '',
      }),
      fabricarPosicao({
        data: '11/08/2026 08:06:30',
        velocidade: 20,
        latitude: -22.736,
        longitude: -43.385,
        endereco: '',
      }),
      fabricarPosicao({
        data: '11/08/2026 08:07:27',
        velocidade: 0,
        latitude: -22.73528,
        longitude: -43.386809,
        endereco: '',
      }),
    ];
    return segmentarViagens(fabricarRelatorio([], posicoes));
  }

  const paradasReais = [
    fabricarParada({
      dataInicio: '11/08/2026 00:02:04',
      dataFim: '11/08/2026 08:05:59',
      latitude: -22.739493,
      longitude: -43.386076,
      endereco: END_ABIRU,
    }),
    // Parada (de outro momento do dia) na rua onde o movimento começou
    fabricarParada({
      dataInicio: '11/08/2026 08:11:05',
      dataFim: '11/08/2026 08:11:19',
      latitude: -22.73652,
      longitude: -43.387587,
      endereco: END_UMBELINA,
    }),
    fabricarParada({
      dataInicio: '11/08/2026 08:07:27',
      dataFim: '11/08/2026 08:10:43',
      latitude: -22.73528,
      longitude: -43.386809,
      endereco: END_CELIA,
    }),
  ];

  it('rotula os extremos pela parada mais próxima em COORDENADAS (paridade com a plataforma)', () => {
    const [viagem] = enriquecerEnderecosComParadas(
      fabricarViagens(),
      paradasReais,
    );

    // Origem = onde o movimento começou (Rua Umbelina), NÃO onde o carro
    // dormiu (Rua Abiru) — comportamento do relatório Deslocamento/Parada
    expect(viagem.inicioEndereco).toBe(END_UMBELINA);
    // Destino = parada seguinte, cujas coordenadas coincidem com o fim
    expect(viagem.fimEndereco).toBe(END_CELIA);
  });

  it('não preenche quando a parada mais próxima está além do raio de 500 m', () => {
    const paradasDistantes = [
      fabricarParada({
        dataInicio: '11/08/2026 15:00:00',
        dataFim: '11/08/2026 16:00:00',
        latitude: -22.9,
        longitude: -43.2,
        endereco: 'Endereço Distante 1 Centro Rio de Janeiro RJ',
      }),
    ];

    const [viagem] = enriquecerEnderecosComParadas(
      fabricarViagens(),
      paradasDistantes,
    );

    expect(viagem.inicioEndereco).toBeUndefined();
    expect(viagem.fimEndereco).toBeUndefined();
  });

  it('preserva endereços que as posições já forneceram', () => {
    const viagens = segmentarViagens(fabricarRelatorioReal());

    const [viagem] = enriquecerEnderecosComParadas(viagens, paradasReais);

    // A posição de início do relatório real já veio com endereço próprio
    expect(viagem.inicioEndereco).toBe(END_ABIRU);
  });
});

// ============================================================
// Mapeamento para o shape Softruck
// ============================================================

describe('mapearResumoDias', () => {
  it('mapeia deslocamentos para o shape do /resumo com acc, ISO -03:00 e kind TRAJECTORY', () => {
    const viagens = segmentarViagens(fabricarRelatorioReal());
    const dias = mapearResumoDias(viagens, 1325811);

    expect(dias).toHaveLength(1);
    expect(dias[0].data).toBe('2026-08-11');
    expect(dias[0].acc).toBe(20260811);
    expect(dias[0].enterpriseId).toBe('');
    expect(dias[0].items).toHaveLength(2);

    const [item] = dias[0].items;
    expect(item.kind).toBe('TRAJECTORY');
    if (item.kind !== 'TRAJECTORY') return;

    expect(item.trajetoId).toBe(`logica-1325811-${viagens[0].inicioTs}`);
    expect(item.inicio.act).toBe('2026-08-11T08:05:59-03:00');
    expect(item.inicio.act.endsWith('-03:00')).toBe(true);
    expect(item.fim.act).toBe('2026-08-11T08:07:27-03:00');
    expect(item.inicio.adr).toBe(END_ABIRU);
    expect(item.fim.adr).toBe(END_CELIA);
  });
});

describe('mapearSegmentosHistorico', () => {
  it('mapeia deslocamentos para HistoricoSegmentoDto com coordenadas dos extremos', () => {
    const viagens = segmentarViagens(fabricarRelatorioReal());
    const [segmento] = mapearSegmentosHistorico(viagens, 1325811);

    expect(segmento.id).toBe(`logica-1325811-${viagens[0].inicioTs}`);
    expect(segmento.acc).toBe(20260811);
    expect(segmento.inicio.lat).toBe(-22.739493);
    expect(segmento.inicio.lng).toBe(-43.386076);
    expect(segmento.fim.lat).toBe(-22.737512);
    expect(segmento.fim.lng).toBe(-43.383153);
    // Mesmo instante do resumo — o app cruza os dois endpoints
    expect(new Date(segmento.inicio.act).getTime() / 1000).toBe(
      viagens[0].inicioTs,
    );
  });
});

describe('mapearRotasFeatures', () => {
  it('gera uma feature DETAILED por ponto com acc, act unix e ign booleana', () => {
    const viagens = segmentarViagens(fabricarRelatorioReal());
    const features = mapearRotasFeatures(viagens);

    expect(features.length).toBeGreaterThan(0);

    const feature = features.find(
      (f) => f.properties.point.act === 1786447754,
    )!;
    expect(feature).toBeDefined();
    expect(feature.type).toBe('Feature');
    expect(feature.properties.type).toBe('DETAILED');
    expect(feature.geometry.coordinates).toEqual([-43.350689, -22.732493]);

    const { point } = feature.properties;
    expect(point.did).toBe('0862667085433137');
    expect(point.acc).toBe(20260811);
    expect(point.act).toBe(1786447754);
    expect(typeof point.ign).toBe('boolean');
    expect(point.spd).toBe(38);
    expect(point.tag).toBe('gps');
    // dir é omitido: a Lógica manda cardinal ("NORTE"), não graus
    expect(point.dir).toBeUndefined();
  });

  it('todos os pontos da trilha caem na janela [inicio.act, fim.act] do resumo', () => {
    const viagens = segmentarViagens(fabricarRelatorioReal());
    const dias = mapearResumoDias(viagens, 1325811);
    const features = mapearRotasFeatures(viagens);

    // Nenhuma feature fora das janelas — tudo o que é enviado é desenhável
    const janelas = dias[0].items.map((item) => {
      if (item.kind !== 'TRAJECTORY') throw new Error('esperado TRAJECTORY');
      return {
        inicio: new Date(item.inicio.act).getTime() / 1000,
        fim: new Date(item.fim.act).getTime() / 1000,
      };
    });

    for (const feature of features) {
      const act = feature.properties.point.act ?? 0;
      const dentroDeAlgumaJanela = janelas.some(
        (j) => act >= j.inicio && act <= j.fim,
      );
      expect(dentroDeAlgumaJanela).toBe(true);
    }
  });
});

describe('mapearVehicleInfo', () => {
  it('monta o VehicleInfoDto a partir do veículo da Lógica', () => {
    expect(
      mapearVehicleInfo('9BD111060T5002156', {
        id: 1325811,
        placa: 'KXC9D02',
        marca: 'FIAT',
        modelo: 'UNO',
      }),
    ).toEqual({
      chassi: '9BD111060T5002156',
      plate: 'KXC9D02',
      brandName: 'FIAT',
      modelName: 'UNO',
    });
  });
});

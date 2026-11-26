import {
  CODIGO_FALHA_DE_TRANSPORTE,
  descreverFalhaDeTransporte,
  descreverRecusa,
  ehFalhaDeTransporte,
  fatiar,
} from 'src/boleto-notificacao/domain/regua-envio';
import {
  montarPush,
  textosDoGrupo,
} from 'src/boleto-notificacao/domain/regua-mensagens';
import {
  avaliarRegua,
  basesJaConcluidas,
  cobertura,
  metricasVazias,
  progressoAposTentativa,
  ReguaIncompletaError,
  ResultadoMomento,
  todasEmCurso,
} from 'src/boleto-notificacao/domain/regua-resultado';
import { ehErroTransitorio } from 'src/shared/erros/erros';

function etapa(
  tenant: string,
  campos: Partial<ResultadoMomento> & { pendentes?: number } = {},
): ResultadoMomento {
  const { pendentes, ...resto } = campos;
  return {
    tenant,
    tipo: 'D0',
    dataReferencia: '31/12/2026',
    dataAlvo: '31/12/2026',
    gatilho: true,
    dryRun: false,
    execucaoId: 1,
    status: 'CONCLUIDA',
    metricas: { ...metricasVazias(), totalPendentes: pendentes ?? 0 },
    ...resto,
  };
}

describe('avaliarRegua — a régua de cada base fechou?', () => {
  it('todas as etapas concluídas e nada pendente: base concluída, régua completa', () => {
    const avaliacao = avaliarRegua([etapa('A'), etapa('A', { tipo: 'D5' })]);

    expect(avaliacao).toEqual({
      dataReferencia: '31/12/2026',
      basesEmFalha: [],
      basesComPendencia: [],
      basesConcluidas: ['A'],
      incompleta: false,
    });
  });

  it('uma etapa em FALHA põe a base em falha, com o erro dela; as outras bases não são afetadas', () => {
    const avaliacao = avaliarRegua([
      etapa('A', { status: 'FALHA', erro: 'SGA respondeu HTTP 403' }),
      etapa('A', { tipo: 'D5' }),
      etapa('B'),
    ]);

    expect(avaliacao.basesEmFalha).toEqual([
      { base: 'A', erro: 'SGA respondeu HTTP 403' },
    ]);
    expect(avaliacao.basesConcluidas).toEqual(['B']);
    expect(avaliacao.incompleta).toBe(true);
  });

  it('envio pendente (sem confirmação) deixa a base com pendência, somando as etapas', () => {
    const avaliacao = avaliarRegua([
      etapa('A', { pendentes: 2 }),
      etapa('A', { tipo: 'D5', pendentes: 3 }),
    ]);

    expect(avaliacao.basesComPendencia).toEqual([{ base: 'A', pendentes: 5 }]);
    expect(avaliacao.basesConcluidas).toEqual([]);
    expect(avaliacao.incompleta).toBe(true);
  });

  it('base pulada por outra execução em curso: nem falha nem concluída', () => {
    const avaliacao = avaliarRegua([
      etapa('A', { status: 'PULADA', motivoDoPulo: 'EXECUCAO_EM_CURSO' }),
    ]);

    expect(avaliacao).toMatchObject({
      basesEmFalha: [],
      basesComPendencia: [],
      basesConcluidas: [],
      incompleta: false,
    });
  });

  it('base já concluída numa tentativa anterior continua concluída', () => {
    const avaliacao = avaliarRegua([
      etapa('A', { status: 'PULADA', motivoDoPulo: 'JA_CONCLUIDA' }),
    ]);
    expect(avaliacao.basesConcluidas).toEqual(['A']);
  });

  it('dry-run não conclui base nenhuma; sem resultados não há o que repetir', () => {
    expect(
      avaliarRegua([etapa('A', { status: 'DRY_RUN' })]).basesConcluidas,
    ).toEqual([]);
    expect(avaliarRegua([])).toMatchObject({
      dataReferencia: null,
      incompleta: false,
    });
  });

  it('todasEmCurso: só quando NENHUMA base rodou', () => {
    const emCurso = (base: string) =>
      etapa(base, { status: 'PULADA', motivoDoPulo: 'EXECUCAO_EM_CURSO' });

    expect(todasEmCurso([emCurso('A'), emCurso('B')])).toBe(true);
    expect(todasEmCurso([emCurso('A'), etapa('B')])).toBe(false);
    expect(
      todasEmCurso([
        etapa('A', { status: 'PULADA', motivoDoPulo: 'JA_CONCLUIDA' }),
      ]),
    ).toBe(false);
    expect(todasEmCurso([])).toBe(false);
  });
});

describe('ReguaIncompletaError', () => {
  it('nomeia as bases em falha e as com pendência, e é transitório (a fila repete)', () => {
    const erro = new ReguaIncompletaError(
      avaliarRegua([
        etapa('MAIS_PRIME', { status: 'FALHA', erro: 'HTTP 403' }),
        etapa('MAIS_PRIME_RS', { pendentes: 4 }),
        etapa('OUTRA'),
      ]),
    );

    expect(erro.message).toBe(
      'Régua de boletos incompleta em 31/12/2026 — bases em falha: MAIS_PRIME (HTTP 403) | bases com envios pendentes: MAIS_PRIME_RS (4)',
    );
    expect(erro.message).not.toContain('OUTRA');
    expect(erro.avaliacao.basesConcluidas).toEqual(['OUTRA']);
    expect(ehErroTransitorio(erro)).toBe(true);
  });
});

describe('progresso do job entre tentativas', () => {
  const progresso = { dataReferencia: '31/12/2026', basesConcluidas: ['A'] };

  it('vale só para a MESMA data de referência', () => {
    expect(basesJaConcluidas(progresso, '31/12/2026')).toEqual(['A']);
    expect(basesJaConcluidas(progresso, '01/01/2027')).toEqual([]);
    expect(basesJaConcluidas(undefined, '31/12/2026')).toEqual([]);
    expect(basesJaConcluidas(null, '31/12/2026')).toEqual([]);
  });

  it('payload estranho não derruba o job: ignora o que não é nome de base', () => {
    expect(
      basesJaConcluidas(
        { dataReferencia: '31/12/2026', basesConcluidas: 'A' } as never,
        '31/12/2026',
      ),
    ).toEqual([]);
    expect(
      basesJaConcluidas(
        { dataReferencia: '31/12/2026', basesConcluidas: ['A', 7] } as never,
        '31/12/2026',
      ),
    ).toEqual(['A']);
  });

  it('acumula as bases concluídas nesta tentativa com as anteriores', () => {
    const avaliacao = avaliarRegua([
      etapa('B'),
      etapa('C', { status: 'FALHA', erro: 'x' }),
    ]);
    expect(progressoAposTentativa(avaliacao, ['A'])).toEqual({
      dataReferencia: '31/12/2026',
      basesConcluidas: ['A', 'B'],
    });
    expect(progressoAposTentativa(avaliarRegua([]), ['A'])).toBeNull();
  });
});

describe('convenção do expoErro e montagem do push', () => {
  it('só SEND_ERROR é falha de transporte', () => {
    expect(CODIGO_FALHA_DE_TRANSPORTE).toBe('SEND_ERROR');
    expect(descreverFalhaDeTransporte('socket hang up')).toBe(
      'SEND_ERROR: socket hang up',
    );
    expect(descreverFalhaDeTransporte()).toBe('SEND_ERROR: erro desconhecido');
    expect(ehFalhaDeTransporte('SEND_ERROR: socket hang up')).toBe(true);
    expect(ehFalhaDeTransporte('DeviceNotRegistered: x')).toBe(false);
    expect(ehFalhaDeTransporte('TICKET_ERROR: SEND_ERROR: x')).toBe(false);
    expect(ehFalhaDeTransporte(null)).toBe(false);
  });

  it('recusa do Expo: código do Expo quando vem, senão o código padrão; cabe na coluna', () => {
    expect(descreverRecusa('MessageTooBig', 'grande', 'TICKET_ERROR')).toBe(
      'MessageTooBig: grande',
    );
    expect(descreverRecusa(undefined, 'recusado', 'RECEIPT_ERROR')).toBe(
      'RECEIPT_ERROR: recusado',
    );
    expect(
      descreverRecusa(undefined, 'x'.repeat(400), 'TICKET_ERROR'),
    ).toHaveLength(255);
  });

  it('fatiar preserva a ordem e o resto', () => {
    expect(fatiar([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(fatiar([], 100)).toEqual([]);
    expect(
      fatiar(
        Array.from({ length: 250 }, (_, i) => i),
        100,
      ).map((l) => [l[0], l.length]),
    ).toEqual([
      [0, 100],
      [100, 100],
      [200, 50],
    ]);
  });

  it('cobertura: 4 casas; sem denominador é null', () => {
    expect(cobertura(1, 3)).toBe(0.3333);
    expect(cobertura(0, 5)).toBe(0);
    expect(cobertura(1, 0)).toBeNull();
  });

  it('textos e push de um grupo: tokens do primeiro boleto, deep-link do financeiro', () => {
    const grupo = {
      vencimento: new Date(2026, 11, 31),
      boletos: [
        {
          nomeAssociado: 'MARIA DE SOUZA',
          mesReferente: '12/2026',
          veiculos: [{ placa: ' QWE1R23 ' }],
        },
        { nomeAssociado: 'OUTRO', mesReferente: '11/2026', veiculos: [] },
      ] as never[],
    };
    const textos = textosDoGrupo(grupo, {
      titulo: 'Boleto de {mes}',
      corpo: '{nome}: {placa}, {data}, {vencimento}, {quantidade} boleto(s)',
    });

    expect(textos).toEqual({
      titulo: 'Boleto de Dezembro',
      corpo: 'Maria: QWE1R23, 31/12, 31/12/2026, 2 boleto(s)',
    });
    expect(
      montarPush(
        { ...grupo, ...textos, expoPushToken: 'ExponentPushToken[x]' },
        'D0',
      ),
    ).toEqual({
      to: 'ExponentPushToken[x]',
      title: 'Boleto de Dezembro',
      body: 'Maria: QWE1R23, 31/12, 31/12/2026, 2 boleto(s)',
      data: {
        type: 'internal_route',
        screen: 'financeiro',
        origem: 'boleto_cobranca',
        tipoMensagem: 'D0',
        dataVencimentoOriginal: '2026-12-31',
        quantidadeBoletos: 2,
      },
      sound: 'default',
      priority: 'high',
      channelId: 'alerts_v2',
      _contentAvailable: true,
      mutableContent: true,
    });
  });

  it('boleto sem placa: o texto usa "seu veículo"', () => {
    const textos = textosDoGrupo(
      {
        vencimento: new Date(2026, 8, 10),
        boletos: [
          { nomeAssociado: '', mesReferente: '', veiculos: [] },
        ] as never[],
      },
      { titulo: '{placa}', corpo: '{nome} — {mes}' },
    );
    expect(textos).toEqual({
      titulo: 'seu veículo',
      corpo: 'Associado — este mês',
    });
  });
});

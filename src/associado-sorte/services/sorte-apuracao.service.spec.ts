import { Test } from '@nestjs/testing';
import { SorteConfigRepository } from 'src/associado-sorte/repositories/sorte-config.repository';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAleatorioService } from 'src/associado-sorte/services/sorte-aleatorio.service';
import { SorteApuracaoService } from 'src/associado-sorte/services/sorte-apuracao.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';
import { configDeTeste } from 'src/associado-sorte/testing/sorte-fixtures';
import { SorteTxMemoria } from 'src/associado-sorte/testing/sorte-tx.memoria';

describe('SorteApuracaoService', () => {
  let service: SorteApuracaoService;
  let tx: SorteTxMemoria;

  const RODADA = 3;
  const PREMIO = 9;

  const config = { obter: jest.fn() };
  const notificacoes = { avisarGanhadores: jest.fn() };
  /** Fila de valores para o sorteio; o código do prêmio usa o contador. */
  let sorteio: number[] = [];
  let contador = 0;
  const aleatorio = {
    inteiro: jest.fn((max: number) =>
      max === 31 ? contador++ % 31 : (sorteio.shift() ?? 0),
    ),
  };

  const inscrever = (userId: number, bilhetes: number, extra: object = {}) =>
    tx.comParticipacao({
      rodadaId: RODADA,
      userId,
      bilhetes,
      creditosGastos: bilhetes * 2,
      ...extra,
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    sorteio = [];
    contador = 0;
    tx = new SorteTxMemoria()
      .comRodada({
        id: RODADA,
        premioId: PREMIO,
        mecanica: 'SORTEIO',
        quantidade: 2,
        custoCreditos: 2,
        abertura: new Date(Date.now() - 3_600_000),
        encerramento: new Date(Date.now() - 1_000),
      })
      .comPremio(PREMIO, 10);
    config.obter.mockResolvedValue(configDeTeste());
    notificacoes.avisarGanhadores.mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        SorteApuracaoService,
        SorteGanhadoresService,
        SorteCreditosService,
        { provide: SorteUnidadeTrabalho, useValue: tx.unidadeDeTrabalho() },
        { provide: SorteConfigService, useValue: config },
        { provide: SorteConfigRepository, useValue: {} },
        { provide: SorteCreditosRepository, useValue: {} },
        { provide: SorteGanhadoresRepository, useValue: {} },
        { provide: SorteAleatorioService, useValue: aleatorio },
        { provide: SorteNotificacoesService, useValue: notificacoes },
      ],
    }).compile();
    service = module.get(SorteApuracaoService);
  });

  it('sorteia ganhadores distintos, baixa o estoque e encerra a rodada', async () => {
    inscrever(1, 1);
    inscrever(2, 3);
    inscrever(3, 6);
    sorteio = [0, 0];

    const r = await service.apurar(RODADA);

    expect(r.jaApurada).toBe(false);
    expect(tx.ganhadores.map((g) => g.userId)).toEqual([1, 2]);
    expect(new Set(tx.ganhadores.map((g) => g.codigo)).size).toBe(2);
    expect(tx.ganhadores[1]).toMatchObject({
      rodadaId: RODADA,
      premioId: PREMIO,
      origem: 'SORTEIO',
      creditosGastos: 6,
    });
    expect(tx.premios.get(PREMIO)!.estoque).toBe(8);
    expect(
      tx.movimentos.map((m) => [m.tipo, m.quantidade, m.estoqueApos]),
    ).toEqual([
      ['SAIDA_GANHADOR', -1, 9],
      ['SAIDA_GANHADOR', -1, 8],
    ]);
    expect(tx.rodadas.get(RODADA)).toMatchObject({
      estado: 'ENCERRADA',
      quantidadeRestante: 0,
    });
    expect(tx.rodadas.get(RODADA)!['apuradaEm']).toBeInstanceOf(Date);
    expect(notificacoes.avisarGanhadores).toHaveBeenCalledWith(r.ganhadorIds);
  });

  it('a chance é proporcional aos bilhetes', async () => {
    inscrever(1, 1);
    inscrever(2, 3);
    inscrever(3, 6);
    // Total 10: ponto 4 cai no associado 3 (bilhetes 4..9).
    // Restam 1 e 2 (total 4): ponto 1 cai no associado 2 (bilhetes 1..3).
    sorteio = [4, 1];

    await service.apurar(RODADA);

    expect(tx.ganhadores.map((g) => g.userId)).toEqual([3, 2]);
    const pedidos = aleatorio.inteiro.mock.calls
      .map(([max]) => max)
      .filter((max) => max !== 31);
    expect(pedidos).toEqual([10, 4]);
  });

  it('guarda o resumo da apuração para auditoria', async () => {
    inscrever(1, 1);
    inscrever(2, 3);
    inscrever(3, 6);

    const r = await service.apurar(RODADA, 'MANUAL');

    expect(r.resumo).toMatchObject({
      origem: 'MANUAL',
      totalInscritos: 3,
      totalBilhetes: 10,
      elegiveis: 3,
      bilhetesElegiveis: 10,
      puladosPorCarencia: 0,
      puladosPorInatividade: 0,
      unidades: 2,
      estoqueNaApuracao: 10,
      limitadoPeloEstoque: false,
      ganhadores: 2,
    });
    expect(tx.rodadas.get(RODADA)!['resumoApuracao']).toEqual(r.resumo);
  });

  it('menos inscritos que unidades: todos ganham e sobra unidade', async () => {
    inscrever(1, 2);

    const r = await service.apurar(RODADA);

    expect(tx.ganhadores.map((g) => g.userId)).toEqual([1]);
    expect(r.resumo!.ganhadores).toBe(1);
    expect(tx.rodadas.get(RODADA)!.quantidadeRestante).toBe(1);
    expect(tx.premios.get(PREMIO)!.estoque).toBe(9);
  });

  it('sem inscritos: encerra sem ganhador e o estoque não muda', async () => {
    const r = await service.apurar(RODADA);

    expect(r).toMatchObject({ jaApurada: false, ganhadorIds: [] });
    expect(r.resumo).toMatchObject({ totalInscritos: 0, ganhadores: 0 });
    expect(tx.ganhadores).toHaveLength(0);
    expect(tx.movimentos).toHaveLength(0);
    expect(tx.premios.get(PREMIO)!.estoque).toBe(10);
    expect(tx.rodadas.get(RODADA)).toMatchObject({
      estado: 'ENCERRADA',
      quantidadeRestante: 2,
    });
    expect(notificacoes.avisarGanhadores).not.toHaveBeenCalled();
  });

  it('idempotência: apurar duas vezes não gera ganhadores em dobro', async () => {
    inscrever(1, 1);
    inscrever(2, 1);
    inscrever(3, 1);

    const primeira = await service.apurar(RODADA);
    const segunda = await service.apurar(RODADA);

    expect(primeira.jaApurada).toBe(false);
    expect(segunda).toEqual({
      rodadaId: RODADA,
      jaApurada: true,
      resumo: null,
      ganhadorIds: [],
    });
    expect(tx.ganhadores).toHaveLength(2);
    expect(tx.premios.get(PREMIO)!.estoque).toBe(8);
    expect(notificacoes.avisarGanhadores).toHaveBeenCalledTimes(1);
  });

  it('confere o estado com a rodada travada antes de sortear', async () => {
    inscrever(1, 1);
    await service.apurar(RODADA);
    expect(tx.travas.slice(0, 2)).toEqual([
      `rodada:${RODADA}`,
      `premio:${PREMIO}`,
    ]);
  });

  it('quem está em carência é pulado', async () => {
    config.obter.mockResolvedValue(configDeTeste({ carenciaDias: 30 }));
    tx.emCarencia.add(1);
    inscrever(1, 50);
    inscrever(2, 1);
    inscrever(3, 1);

    const r = await service.apurar(RODADA);

    expect(tx.ganhadores.map((g) => g.userId).sort()).toEqual([2, 3]);
    expect(r.resumo).toMatchObject({
      totalInscritos: 3,
      elegiveis: 2,
      puladosPorCarencia: 1,
    });
  });

  it('a carência é a da base de cada inscrito', async () => {
    config.obter.mockImplementation((base: string) =>
      Promise.resolve(
        configDeTeste({ carenciaDias: base === 'MAIS_PRIME_RS' ? 30 : 0 }),
      ),
    );
    tx.emCarencia.add(1).add(2);
    inscrever(1, 1); // MAIS_PRIME: carência desligada, concorre
    inscrever(2, 1, { baseOrigin: 'MAIS_PRIME_RS' }); // pulado

    await service.apurar(RODADA);

    expect(tx.ganhadores.map((g) => g.userId)).toEqual([1]);
  });

  it('associado com cadastro inativo é pulado', async () => {
    inscrever(1, 1, { ativo: false });
    inscrever(2, 1);

    const r = await service.apurar(RODADA);

    expect(tx.ganhadores.map((g) => g.userId)).toEqual([2]);
    expect(r.resumo!.puladosPorInatividade).toBe(1);
  });

  it('estoque menor que as unidades: premia só até onde alcança e registra', async () => {
    tx.premios.get(PREMIO)!.estoque = 1;
    inscrever(1, 1);
    inscrever(2, 1);
    inscrever(3, 1);

    const r = await service.apurar(RODADA);

    expect(tx.ganhadores).toHaveLength(1);
    expect(tx.premios.get(PREMIO)!.estoque).toBe(0);
    expect(r.resumo).toMatchObject({
      estoqueNaApuracao: 1,
      limitadoPeloEstoque: true,
      ganhadores: 1,
    });
  });

  it('antes do encerramento → 409 RODADA_NAO_ENCERRADA, nada muda', async () => {
    tx.rodadas.get(RODADA)!.encerramento = new Date(Date.now() + 60_000);
    inscrever(1, 1);

    await expect(service.apurar(RODADA, 'MANUAL')).rejects.toMatchObject({
      response: { code: 'RODADA_NAO_ENCERRADA' },
    });
    expect(tx.ganhadores).toHaveLength(0);
    expect(tx.rodadas.get(RODADA)!.estado).toBe('PUBLICADA');
  });

  it('rodada cancelada ou em rascunho não é apurada', async () => {
    tx.rodadas.get(RODADA)!.estado = 'CANCELADA';
    await expect(service.apurar(RODADA)).rejects.toMatchObject({
      response: { code: 'RODADA_NAO_PUBLICADA' },
    });
  });

  it('corrida e vitrine não são apuradas → 400', async () => {
    tx.rodadas.get(RODADA)!.mecanica = 'CORRIDA';
    await expect(service.apurar(RODADA)).rejects.toMatchObject({ status: 400 });
  });
});

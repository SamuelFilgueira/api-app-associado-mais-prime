import { HttpException, Logger } from '@nestjs/common';
import { EconomiaService } from 'src/economia/services/economia.service';
import { FuelSessionRepository } from 'src/fuel-session/repositories/fuel-session.repository';
import { FuelSessionService } from 'src/fuel-session/services/fuel-session.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import { FUEL_ECONOMY_QUEUE } from 'src/queue/queue.module';
import { InfraError } from 'src/shared/erros/erros';

describe('FuelSessionService — abrirSessao()', () => {
  const sessoes = {
    expirarPendentesVencidas: jest.fn(),
    buscarPendenteDoUsuario: jest.fn(),
    criarPendente: jest.fn(),
    expirar: jest.fn(),
  };
  const economia = { consultarTotalEconomizado: jest.fn() };
  const produtor = { enfileirar: jest.fn() };
  let service: FuelSessionService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-11-25T12:00:00.000Z') });
    for (const nivel of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
    sessoes.expirarPendentesVencidas.mockResolvedValue(0);
    sessoes.buscarPendenteDoUsuario.mockResolvedValue(null);
    sessoes.criarPendente.mockResolvedValue({
      sessao: { id: 'sessao-1', userId: 42, valorAntes: 87.5 },
      criada: true,
    });
    sessoes.expirar.mockResolvedValue(true);
    economia.consultarTotalEconomizado.mockResolvedValue({
      totalEconomizado: '87.50',
    });
    produtor.enfileirar.mockResolvedValue({ id: 'fuel-sessao-1-c1' });
    service = new FuelSessionService(
      sessoes as unknown as FuelSessionRepository,
      economia as unknown as EconomiaService,
      produtor as unknown as ProdutorDeFilas,
    );
  });

  afterEach(() => jest.useRealTimers());
  afterAll(() => jest.restoreAllMocks());

  it('o valor de partida é o total lido do Clubgas no momento do toque', async () => {
    const abertura = await service.abrirSessao(42, 'MAIS_PRIME');

    expect(economia.consultarTotalEconomizado).toHaveBeenCalledWith(42, 'APP');
    expect(sessoes.criarPendente).toHaveBeenCalledWith(42, 87.5);
    expect(abertura).toEqual({
      situacao: 'ABERTA',
      sessao: { id: 'sessao-1', userId: 42, valorAntes: 87.5 },
    });
  });

  it('agenda a primeira checagem para 5 minutos depois, com a base e o jobId da sessão — sem opções de retry próprias', async () => {
    await service.abrirSessao(42, 'MAIS_PRIME_RS');

    expect(produtor.enfileirar).toHaveBeenCalledTimes(1);
    expect(produtor.enfileirar).toHaveBeenCalledWith(
      FUEL_ECONOMY_QUEUE,
      'check-fuel-economy',
      { fuelSessionId: 'sessao-1', checagem: 1 },
      {
        base: 'MAIS_PRIME_RS',
        atrasoMs: 5 * 60 * 1000,
        jobId: 'fuel-sessao-1-c1',
      },
    );
  });

  it('já existe sessão pendente: devolve a que existe, sem ir ao Clubgas nem enfileirar', async () => {
    const pendente = { id: 'pendente', userId: 42 };
    sessoes.buscarPendenteDoUsuario.mockResolvedValue(pendente);

    await expect(service.abrirSessao(42, 'MAIS_PRIME')).resolves.toEqual({
      situacao: 'JA_PENDENTE',
      sessao: pendente,
    });
    expect(economia.consultarTotalEconomizado).not.toHaveBeenCalled();
    expect(sessoes.criarPendente).not.toHaveBeenCalled();
    expect(produtor.enfileirar).not.toHaveBeenCalled();
  });

  it('dois toques simultâneos: quem perde no índice único recebe a sessão do outro e não enfileira', async () => {
    const doOutroToque = { id: 'sessao-do-outro', userId: 42 };
    sessoes.criarPendente.mockResolvedValue({
      sessao: doOutroToque,
      criada: false,
    });

    await expect(service.abrirSessao(42, 'MAIS_PRIME')).resolves.toEqual({
      situacao: 'JA_PENDENTE',
      sessao: doOutroToque,
    });
    expect(produtor.enfileirar).not.toHaveBeenCalled();
  });

  it('sessões pendentes com mais de 30 minutos vencem antes de qualquer outra coisa', async () => {
    sessoes.expirarPendentesVencidas.mockResolvedValue(1);

    await service.abrirSessao(42, 'MAIS_PRIME');

    expect(sessoes.expirarPendentesVencidas).toHaveBeenCalledWith(
      42,
      new Date('2026-11-25T11:30:00.000Z'),
    );
    expect(
      sessoes.expirarPendentesVencidas.mock.invocationCallOrder[0],
    ).toBeLessThan(sessoes.buscarPendenteDoUsuario.mock.invocationCallOrder[0]);
  });

  it.each([
    ['ausente', {}],
    ['não numérico', { totalEconomizado: 'abc' }],
    ['corpo nulo', null],
  ])(
    'Clubgas sem total numérico (%s): não cria sessão nem enfileira',
    async (_caso, resposta) => {
      economia.consultarTotalEconomizado.mockResolvedValue(resposta);

      await expect(service.abrirSessao(42, 'MAIS_PRIME')).resolves.toEqual({
        situacao: 'SEM_VALOR_DE_PARTIDA',
        sessao: null,
      });
      expect(sessoes.criarPendente).not.toHaveBeenCalled();
      expect(produtor.enfileirar).not.toHaveBeenCalled();
    },
  );

  it('total zero é um valor de partida válido', async () => {
    economia.consultarTotalEconomizado.mockResolvedValue({
      totalEconomizado: '0',
    });

    await service.abrirSessao(42, 'MAIS_PRIME');

    expect(sessoes.criarPendente).toHaveBeenCalledWith(42, 0);
  });

  it('Clubgas fora na leitura do total: o erro sai como veio e nenhuma sessão é criada', async () => {
    const falha = new HttpException(
      { statusCode: 504, code: 'CLUBGAS_TIMEOUT' },
      504,
    );
    economia.consultarTotalEconomizado.mockRejectedValue(falha);

    await expect(service.abrirSessao(42, 'MAIS_PRIME')).rejects.toBe(falha);
    expect(sessoes.criarPendente).not.toHaveBeenCalled();
    expect(produtor.enfileirar).not.toHaveBeenCalled();
  });

  it('fila fora depois de criar a sessão: a sessão é desfeita (não fica PENDING sem job) e o erro segue', async () => {
    const falha = new InfraError('fila');
    produtor.enfileirar.mockRejectedValue(falha);

    await expect(service.abrirSessao(42, 'MAIS_PRIME')).rejects.toBe(falha);
    expect(sessoes.expirar).toHaveBeenCalledWith('sessao-1');
  });
});

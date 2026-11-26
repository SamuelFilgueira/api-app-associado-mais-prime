import { HttpException, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';
import { ClubgasErroLogService } from 'src/integrations/clubgas/clubgas-erro-log.service';
import { ClubgasErro } from 'src/integrations/clubgas/clubgas.erro';
import { PostosService } from 'src/postos/services/postos.service';

const posto = (n: number) => ({
  id: n,
  postoNome: `Posto ${n}`,
  enderecoPosto: `Rua ${n}`,
  distancia: n,
  latitude: -22.9,
  longitude: -43.2,
});

/** Redis de mentira (só o que o `CacheService` usa), para o cache ser o de verdade. */
function redisEmMemoria() {
  const dados = new Map<string, string>();
  return {
    dados,
    get: jest.fn((chave: string) => Promise.resolve(dados.get(chave) ?? null)),
    set: jest.fn((chave: string, valor: string) => {
      dados.set(chave, valor);
      return Promise.resolve('OK');
    }),
    del: jest.fn((chave: string) =>
      Promise.resolve(dados.delete(chave) ? 1 : 0),
    ),
  };
}

/**
 * Caracterização de `POST /postos/buscar`: formato da resposta, paginação
 * local de 5 em 5 e o que é registrado em `ClubgasErroLog`.
 */
describe('PostosService — buscarPostos()', () => {
  const prisma = {
    userVehicle: { findFirst: jest.fn() },
    clubgasErroLog: { create: jest.fn() },
  };
  const clubgasClient = { obterPostosMapa: jest.fn() };
  let redis: ReturnType<typeof redisEmMemoria>;
  let service: PostosService;

  const buscar = (page?: number) =>
    service.buscarPostos(-22.9068, -43.1729, 42, 'CHASSI1', page, 'MAIS_PRIME');

  beforeEach(() => {
    jest.clearAllMocks();
    for (const nivel of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
    prisma.userVehicle.findFirst.mockResolvedValue({ plate: 'ABC1D23' });
    prisma.clubgasErroLog.create.mockResolvedValue({});
    clubgasClient.obterPostosMapa.mockResolvedValue({
      result: Array.from({ length: 12 }, (_, i) => posto(i + 1)),
      pagination: { totalElements: 12 },
    });
    redis = redisEmMemoria();
    service = new PostosService(
      prisma as unknown as PrismaService,
      clubgasClient as unknown as ClubgasClient,
      new ClubgasErroLogService(prisma as unknown as PrismaService),
      new CacheService(redis as unknown as Redis),
    );
  });

  afterAll(() => jest.restoreAllMocks());

  it('consulta o Clubgas com a base, as coordenadas e a placa do veículo ativo', async () => {
    await buscar(1);

    expect(prisma.userVehicle.findFirst).toHaveBeenCalledWith({
      where: { userId: 42, chassi: 'CHASSI1', isActive: true },
    });
    expect(clubgasClient.obterPostosMapa).toHaveBeenCalledWith('MAIS_PRIME', {
      latitude: -22.9068,
      longitude: -43.1729,
      placa: 'ABC1D23',
    });
  });

  it('primeira página: 5 postos e a paginação calculada sobre a lista inteira', async () => {
    await expect(buscar(1)).resolves.toEqual({
      pagination: {
        totalElements: 12,
        pageSize: 5,
        pageNumber: 1,
        totalPages: 3,
      },
      result: [1, 2, 3, 4, 5].map(posto),
    });
  });

  it('sem página informada, devolve a primeira', async () => {
    const resposta = await buscar(undefined);

    expect(resposta.pagination.pageNumber).toBe(1);
    expect(resposta.result).toEqual([1, 2, 3, 4, 5].map(posto));
  });

  it('última página: só o resto da lista', async () => {
    const resposta = await buscar(3);

    expect(resposta.pagination).toEqual({
      totalElements: 12,
      pageSize: 5,
      pageNumber: 3,
      totalPages: 3,
    });
    expect(resposta.result).toEqual([11, 12].map(posto));
  });

  it('página além do fim: lista vazia, mesma paginação', async () => {
    const resposta = await buscar(9);

    expect(resposta).toEqual({
      pagination: {
        totalElements: 12,
        pageSize: 5,
        pageNumber: 9,
        totalPages: 3,
      },
      result: [],
    });
  });

  it('`result` fora do contrato (não é lista): responde vazio em vez de quebrar', async () => {
    clubgasClient.obterPostosMapa.mockResolvedValue({
      result: null,
      pagination: { totalElements: 0 },
    });

    await expect(buscar(1)).resolves.toEqual({
      pagination: {
        totalElements: 0,
        pageSize: 5,
        pageNumber: 1,
        totalPages: 0,
      },
      result: [],
    });
  });

  it('placa recusada (lista vazia e sem paginação): mesma resposta, e a ocorrência é registrada', async () => {
    const recusa = { result: [], pagination: null };
    clubgasClient.obterPostosMapa.mockResolvedValue(recusa);

    await expect(buscar(1)).resolves.toEqual({
      pagination: {
        totalElements: 0,
        pageSize: 5,
        pageNumber: 1,
        totalPages: 0,
      },
      result: [],
    });
    expect(prisma.clubgasErroLog.create.mock.calls[0][0].data).toMatchObject({
      userId: 42,
      baseOrigin: 'MAIS_PRIME',
      operacao: 'POSTOS',
      chassi: 'CHASSI1',
      placa: 'ABC1D23',
      categoria: 'PLACA_INVALIDA',
      httpStatus: 200,
    });
  });

  it('sem veículo ativo com placa: 404, log gravado e nenhuma chamada ao Clubgas', async () => {
    prisma.userVehicle.findFirst.mockResolvedValue(null);

    const erro: unknown = await buscar(1).then(
      () => null,
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(HttpException);
    expect((erro as HttpException).getStatus()).toBe(404);
    expect((erro as HttpException).getResponse()).toMatchObject({
      message: 'Placa não encontrada para o usuário',
    });
    expect(clubgasClient.obterPostosMapa).not.toHaveBeenCalled();
    expect(prisma.clubgasErroLog.create.mock.calls[0][0].data).toMatchObject({
      userId: 42,
      chassi: 'CHASSI1',
      placa: null,
      categoria: 'VEICULO_SEM_PLACA',
    });
  });

  it('falha do Clubgas: grava o log do usuário e devolve o erro HTTP classificado', async () => {
    clubgasClient.obterPostosMapa.mockRejectedValue(
      new ClubgasErro({
        operacao: 'POSTOS',
        categoria: 'ERRO_CLUBGAS',
        mensagem: 'Clubgas respondeu HTTP 500',
        httpStatus: 500,
      }),
    );

    const erro: unknown = await buscar(1).then(
      () => null,
      (e: unknown) => e,
    );

    expect((erro as HttpException).getResponse()).toMatchObject({
      statusCode: 502,
      code: 'CLUBGAS_ERRO_CLUBGAS',
    });
    expect(prisma.clubgasErroLog.create.mock.calls[0][0].data).toMatchObject({
      userId: 42,
      baseOrigin: 'MAIS_PRIME',
      operacao: 'POSTOS',
      origem: 'APP',
      placa: 'ABC1D23',
      categoria: 'ERRO_CLUBGAS',
      httpStatus: 500,
    });
  });
  describe('cache da lista do Clubgas', () => {
    it('segunda busca igual (outra página) não chama o Clubgas e pagina sobre a lista guardada', async () => {
      const primeira = await buscar(1);
      const segunda = await buscar(2);
      const terceira = await buscar(3);

      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(1);
      expect(primeira.result).toEqual([1, 2, 3, 4, 5].map(posto));
      expect(segunda).toEqual({
        pagination: {
          totalElements: 12,
          pageSize: 5,
          pageNumber: 2,
          totalPages: 3,
        },
        result: [6, 7, 8, 9, 10].map(posto),
      });
      expect(terceira.result).toEqual([11, 12].map(posto));
    });

    it('a chave é `<base>:postos:<placa>:<lat>:<lng>` e tem prazo de 15 minutos (±10%)', async () => {
      await buscar(1);

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [chave, , modo, segundos] = redis.set.mock.calls[0] as unknown as [
        string,
        string,
        string,
        number,
      ];
      expect(chave).toBe('MAIS_PRIME:postos:ABC1D23:-22.907:-43.173');
      expect(modo).toBe('EX');
      expect(segundos).toBeGreaterThanOrEqual(15 * 60 * 0.9);
      expect(segundos).toBeLessThanOrEqual(15 * 60 * 1.1 + 1);
    });

    it('base A não lê o cache da base B', async () => {
      const daRs = { result: [posto(99)], pagination: { totalElements: 1 } };

      await buscar(1);
      clubgasClient.obterPostosMapa.mockResolvedValue(daRs);
      const outraBase = await service.buscarPostos(
        -22.9068,
        -43.1729,
        42,
        'CHASSI1',
        1,
        'MAIS_PRIME_RS',
      );

      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
      expect(clubgasClient.obterPostosMapa).toHaveBeenLastCalledWith(
        'MAIS_PRIME_RS',
        { latitude: -22.9068, longitude: -43.1729, placa: 'ABC1D23' },
      );
      expect(outraBase.result).toEqual([posto(99)]);
      // E a base A continua com a lista dela.
      expect((await buscar(1)).result).toEqual([1, 2, 3, 4, 5].map(posto));
      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
    });

    it('outro veículo (outra placa) no mesmo lugar consulta o Clubgas', async () => {
      await buscar(1);
      prisma.userVehicle.findFirst.mockResolvedValue({ plate: 'XYZ9A88' });

      await buscar(1);

      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
    });

    it('outro lugar (coordenadas a centenas de metros) consulta o Clubgas', async () => {
      await buscar(1);

      await service.buscarPostos(-22.95, -43.2, 42, 'CHASSI1', 1, 'MAIS_PRIME');

      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
    });

    it('vencido o prazo, a busca volta ao Clubgas', async () => {
      const agora = Date.now();
      const relogio = jest.spyOn(Date, 'now').mockReturnValue(agora);

      await buscar(1);
      relogio.mockReturnValue(agora + 13 * 60_000);
      await buscar(2);
      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(1);

      relogio.mockReturnValue(agora + 17 * 60_000);
      await buscar(2);
      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);

      relogio.mockRestore();
    });

    it('placa recusada (lista vazia e sem paginação) NÃO é guardada: cada busca volta ao Clubgas e registra a ocorrência', async () => {
      clubgasClient.obterPostosMapa.mockResolvedValue({
        result: [],
        pagination: null,
      });

      await buscar(1);
      await buscar(1);

      expect(redis.set).not.toHaveBeenCalled();
      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
      expect(prisma.clubgasErroLog.create).toHaveBeenCalledTimes(2);
    });

    it('`result` fora do contrato NÃO é guardado', async () => {
      clubgasClient.obterPostosMapa.mockResolvedValue({
        result: null,
        pagination: { totalElements: 0 },
      });

      await buscar(1);

      expect(redis.set).not.toHaveBeenCalled();
    });

    it('lista vazia com paginação (nenhum posto por perto) é resposta válida e fica guardada', async () => {
      clubgasClient.obterPostosMapa.mockResolvedValue({
        result: [],
        pagination: { totalElements: 0 },
      });

      await buscar(1);
      await buscar(1);

      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(1);
      expect(prisma.clubgasErroLog.create).not.toHaveBeenCalled();
    });

    it('erro do Clubgas não é guardado: a busca seguinte tenta de novo', async () => {
      clubgasClient.obterPostosMapa.mockRejectedValueOnce(
        new ClubgasErro({
          operacao: 'POSTOS',
          categoria: 'TIMEOUT',
          mensagem: 'ECONNABORTED',
        }),
      );

      await expect(buscar(1)).rejects.toMatchObject({ status: 504 });
      expect(redis.set).not.toHaveBeenCalled();

      await expect(buscar(1)).resolves.toMatchObject({
        pagination: { totalElements: 12 },
      });
      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
    });

    it('Redis fora: a busca vai direto ao Clubgas e responde normalmente', async () => {
      redis.get.mockRejectedValue(new Error('Connection is closed.'));
      redis.set.mockRejectedValue(new Error('Connection is closed.'));

      await expect(buscar(1)).resolves.toMatchObject({
        pagination: { totalElements: 12 },
      });
      await buscar(2);

      expect(clubgasClient.obterPostosMapa).toHaveBeenCalledTimes(2);
    });
  });
});

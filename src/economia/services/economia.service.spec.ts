import { HttpException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { EconomiaService } from 'src/economia/services/economia.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';
import { ClubgasErroLogService } from 'src/integrations/clubgas/clubgas-erro-log.service';
import { ClubgasErro } from 'src/integrations/clubgas/clubgas.erro';

/**
 * Caracterização de `GET /economia/total`: o que a consulta devolve, o que
 * envia ao Clubgas e quando grava o total no cadastro do usuário.
 */
describe('EconomiaService — consultarTotalEconomizado()', () => {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    clubgasErroLog: { create: jest.fn() },
  };
  const clubgasClient = { obterTotalEconomizadoLegado: jest.fn() };
  let service: EconomiaService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.user.findUnique.mockResolvedValue({
      id: 42,
      cpf: '123.456.789-09',
      baseOrigin: 'MAIS_PRIME',
      totalEconomizado: 100,
    });
    prisma.user.update.mockResolvedValue({});
    prisma.clubgasErroLog.create.mockResolvedValue({});
    service = new EconomiaService(
      prisma as unknown as PrismaService,
      clubgasClient as unknown as ClubgasClient,
      new ClubgasErroLogService(prisma as unknown as PrismaService),
    );
  });

  afterAll(() => jest.restoreAllMocks());

  it('envia o CPF só com dígitos e devolve o corpo do Clubgas como veio', async () => {
    const corpo = { totalEconomizado: '100.00', isValid: true };
    clubgasClient.obterTotalEconomizadoLegado.mockResolvedValue(corpo);

    await expect(service.consultarTotalEconomizado(42)).resolves.toBe(corpo);

    expect(clubgasClient.obterTotalEconomizadoLegado).toHaveBeenCalledWith(
      '12345678909',
    );
  });

  it('total maior que o gravado: atualiza `user.totalEconomizado`', async () => {
    clubgasClient.obterTotalEconomizadoLegado.mockResolvedValue({
      totalEconomizado: '112.5',
    });

    await service.consultarTotalEconomizado(42);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { totalEconomizado: 112.5 },
    });
  });

  it.each([
    ['igual ao gravado', '100'],
    ['menor que o gravado', '80'],
    ['não numérico', 'abc'],
    ['ausente', undefined],
  ])('total %s: não grava nada no usuário', async (_caso, total) => {
    clubgasClient.obterTotalEconomizadoLegado.mockResolvedValue({
      totalEconomizado: total,
    });

    await service.consultarTotalEconomizado(42);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    ['usuário inexistente', null],
    ['usuário sem CPF', { id: 42, cpf: null }],
  ])('%s: 404 sem chamar o Clubgas', async (_caso, usuario) => {
    prisma.user.findUnique.mockResolvedValue(usuario);

    await expect(service.consultarTotalEconomizado(42)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(clubgasClient.obterTotalEconomizadoLegado).not.toHaveBeenCalled();
  });

  it('falha do Clubgas: grava o log com a origem informada e devolve o erro HTTP equivalente', async () => {
    clubgasClient.obterTotalEconomizadoLegado.mockRejectedValue(
      new ClubgasErro({
        operacao: 'TOTAL_ECONOMIZADO',
        categoria: 'TIMEOUT',
        mensagem: 'ECONNABORTED: timeout of 15000ms exceeded',
      }),
    );

    const erro: unknown = await service
      .consultarTotalEconomizado(42, 'JOB_ECONOMIA')
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(erro).toBeInstanceOf(HttpException);
    expect((erro as HttpException).getStatus()).toBe(504);
    expect((erro as HttpException).getResponse()).toMatchObject({
      statusCode: 504,
      code: 'CLUBGAS_TIMEOUT',
    });
    expect(prisma.clubgasErroLog.create.mock.calls[0][0].data).toMatchObject({
      userId: 42,
      userDocumento: '12345678909',
      baseOrigin: 'MAIS_PRIME',
      operacao: 'TOTAL_ECONOMIZADO',
      origem: 'JOB_ECONOMIA',
      categoria: 'TIMEOUT',
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('sem origem informada, o log sai como APP', async () => {
    clubgasClient.obterTotalEconomizadoLegado.mockRejectedValue(
      new ClubgasErro({
        operacao: 'TOTAL_ECONOMIZADO',
        categoria: 'ERRO_CLUBGAS',
        mensagem: 'Clubgas respondeu HTTP 500',
        httpStatus: 500,
      }),
    );

    await expect(service.consultarTotalEconomizado(42)).rejects.toMatchObject({
      status: 502,
    });
    expect(prisma.clubgasErroLog.create.mock.calls[0][0].data.origem).toBe(
      'APP',
    );
  });
});

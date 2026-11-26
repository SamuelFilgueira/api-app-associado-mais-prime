import { HttpException, Logger } from '@nestjs/common';
import { CartaoService } from 'src/cartao/services/cartao.service';
import { PrismaService } from 'src/database/prisma.service';
import { FuelSessionService } from 'src/fuel-session/services/fuel-session.service';
import { ClubgasClient } from 'src/integrations/clubgas/clubgas.client';
import { ClubgasErroLogService } from 'src/integrations/clubgas/clubgas-erro-log.service';
import { ClubgasErro } from 'src/integrations/clubgas/clubgas.erro';

describe('CartaoService — gerarCartaoVirtual()', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    userVehicle: { findFirst: jest.fn() },
    clubgasErroLog: { create: jest.fn() },
  };
  const fuelSession = { abrirSessao: jest.fn() };
  const clubgasClient = { obterCartaoVirtual: jest.fn() };
  let service: CartaoService;
  let erroLogado: jest.SpyInstance;

  const capturar = async (): Promise<HttpException> => {
    const erro: unknown = await service
      .gerarCartaoVirtual(42, 'CHASSI1', 'HERTZ')
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(erro).toBeInstanceOf(HttpException);
    return erro as HttpException;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    erroLogado = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    prisma.user.findUnique.mockResolvedValue({
      id: 42,
      cpf: '123.456.789-09',
      totalEconomizado: 0,
    });
    prisma.userVehicle.findFirst.mockResolvedValue({ plate: 'ABC1D23' });
    prisma.clubgasErroLog.create.mockResolvedValue({});
    fuelSession.abrirSessao.mockResolvedValue({
      situacao: 'ABERTA',
      sessao: { id: 'sessao-1' },
    });
    service = new CartaoService(
      prisma as unknown as PrismaService,
      fuelSession as unknown as FuelSessionService,
      clubgasClient as unknown as ClubgasClient,
      new ClubgasErroLogService(prisma as unknown as PrismaService),
    );
  });

  afterAll(() => jest.restoreAllMocks());

  it('envia o documento só com dígitos e devolve o cartão', async () => {
    const cartao = { codCartao: 'Q073', dataValidade: '25/11/2026' };
    clubgasClient.obterCartaoVirtual.mockResolvedValue(cartao);

    await expect(
      service.gerarCartaoVirtual(42, 'CHASSI1', 'HERTZ'),
    ).resolves.toBe(cartao);

    expect(clubgasClient.obterCartaoVirtual).toHaveBeenCalledWith('HERTZ', {
      placa: 'ABC1D23',
      cpf: '12345678909',
    });
    expect(prisma.clubgasErroLog.create).not.toHaveBeenCalled();
  });

  it('com o cartão obtido, abre a verificação de economia do usuário na base dele', async () => {
    clubgasClient.obterCartaoVirtual.mockResolvedValue({ codCartao: 'Q073' });

    await service.gerarCartaoVirtual(42, 'CHASSI1', 'HERTZ');
    // A abertura é em segundo plano (não bloqueia a resposta do cartão).
    await new Promise((resolve) => setImmediate(resolve));

    expect(fuelSession.abrirSessao).toHaveBeenCalledTimes(1);
    expect(fuelSession.abrirSessao).toHaveBeenCalledWith(42, 'HERTZ');
  });

  it('a resposta do cartão não espera a verificação de economia', async () => {
    const cartao = { codCartao: 'Q073' };
    clubgasClient.obterCartaoVirtual.mockResolvedValue(cartao);
    // Nunca resolve: se a rota esperasse por ela, o teste estouraria o tempo.
    fuelSession.abrirSessao.mockReturnValue(new Promise(() => undefined));

    await expect(
      service.gerarCartaoVirtual(42, 'CHASSI1', 'HERTZ'),
    ).resolves.toBe(cartao);
  });

  it('falha ao abrir a verificação (Clubgas fora na leitura do total) não chega à resposta do cartão', async () => {
    const cartao = { codCartao: 'Q073' };
    clubgasClient.obterCartaoVirtual.mockResolvedValue(cartao);
    fuelSession.abrirSessao.mockRejectedValue(
      new HttpException({ statusCode: 502, code: 'CLUBGAS_ERRO_CLUBGAS' }, 502),
    );

    await expect(
      service.gerarCartaoVirtual(42, 'CHASSI1', 'HERTZ'),
    ).resolves.toBe(cartao);
    await new Promise((resolve) => setImmediate(resolve));

    expect(erroLogado).toHaveBeenCalledWith(
      expect.stringContaining(
        'Verificação de economia não aberta para user 42',
      ),
    );
  });

  it('na recusa do Clubgas, grava o log do usuário e devolve 422 com a mensagem', async () => {
    clubgasClient.obterCartaoVirtual.mockRejectedValue(
      new ClubgasErro({
        operacao: 'CARTAO_VIRTUAL',
        categoria: 'DADOS_INVALIDOS',
        mensagem: 'Dados inválidos.',
        httpStatus: 400,
        resposta: { isValid: false, errors: ['Dados inválidos.'] },
      }),
    );

    const erro = await capturar();

    expect(erro.getResponse()).toEqual({
      statusCode: 422,
      code: 'CLUBGAS_DADOS_INVALIDOS',
      message: 'Dados inválidos.',
    });
    expect(prisma.clubgasErroLog.create.mock.calls[0][0].data).toMatchObject({
      userId: 42,
      userDocumento: '12345678909',
      baseOrigin: 'HERTZ',
      operacao: 'CARTAO_VIRTUAL',
      origem: 'APP',
      chassi: 'CHASSI1',
      placa: 'ABC1D23',
      categoria: 'DADOS_INVALIDOS',
      httpStatus: 400,
      mensagem: 'Dados inválidos.',
    });
    // Sem cartão não há abastecimento a verificar.
    expect(fuelSession.abrirSessao).not.toHaveBeenCalled();
  });

  it('sem veículo ativo com placa, grava o log e mantém o 404', async () => {
    prisma.userVehicle.findFirst.mockResolvedValue(null);

    const erro = await capturar();

    expect(erro.getStatus()).toBe(404);
    expect(erro.getResponse()).toMatchObject({
      message: 'Placa não encontrada para o usuário',
    });
    expect(clubgasClient.obterCartaoVirtual).not.toHaveBeenCalled();
    expect(prisma.clubgasErroLog.create.mock.calls[0][0].data).toMatchObject({
      userId: 42,
      chassi: 'CHASSI1',
      placa: null,
      categoria: 'VEICULO_SEM_PLACA',
      httpStatus: null,
    });
  });
});

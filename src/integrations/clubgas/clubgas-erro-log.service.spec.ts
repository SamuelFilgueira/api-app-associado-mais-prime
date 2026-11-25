import { HttpException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { ClubgasErroLogService } from './clubgas-erro-log.service';
import { ClubgasErro } from './clubgas.erro';

describe('ClubgasErroLogService', () => {
  const create = jest.fn();
  const prisma = { clubgasErroLog: { create } } as unknown as PrismaService;
  let service: ClubgasErroLogService;

  const recusa = new ClubgasErro({
    operacao: 'CARTAO_VIRTUAL',
    categoria: 'CARTAO_RECUSADO',
    mensagem: 'Não foi possível gerar seu cartão virtual.',
    httpStatus: 400,
    resposta: { isValid: false, errors: ['Não foi possível gerar…'] },
    duracaoMs: 812,
  });

  const contexto = {
    userId: 42,
    baseOrigin: 'HERTZ',
    chassi: '9BWZZZ377VT004251',
    placa: 'ABC1D23',
    documento: '12345678909',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    create.mockResolvedValue({});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = new ClubgasErroLogService(prisma);
  });

  afterAll(() => jest.restoreAllMocks());

  it('grava o usuário, o que foi enviado e o que o Clubgas respondeu', async () => {
    await service.registrar(recusa, contexto);

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 42,
        userDocumento: '12345678909',
        baseOrigin: 'HERTZ',
        operacao: 'CARTAO_VIRTUAL',
        origem: 'APP',
        chassi: '9BWZZZ377VT004251',
        placa: 'ABC1D23',
        categoria: 'CARTAO_RECUSADO',
        httpStatus: 400,
        mensagem: 'Não foi possível gerar seu cartão virtual.',
        resposta: { isValid: false, errors: ['Não foi possível gerar…'] },
        duracaoMs: 812,
      },
    });
  });

  it('identifica a origem do job e não exige placa/chassi', async () => {
    await service.registrar(
      new ClubgasErro({
        operacao: 'TOTAL_ECONOMIZADO',
        categoria: 'TIMEOUT',
        mensagem: 'ECONNABORTED: timeout of 15000ms exceeded',
      }),
      { userId: 7, origem: 'JOB_ECONOMIA', documento: '12345678909' },
    );

    expect(create.mock.calls[0][0].data).toMatchObject({
      userId: 7,
      origem: 'JOB_ECONOMIA',
      operacao: 'TOTAL_ECONOMIZADO',
      categoria: 'TIMEOUT',
      httpStatus: null,
      chassi: null,
      placa: null,
      baseOrigin: null,
      resposta: undefined,
    });
  });

  it('trunca mensagem e resposta grandes', async () => {
    await service.registrar(
      new ClubgasErro({
        operacao: 'POSTOS',
        categoria: 'ERRO_CLUBGAS',
        mensagem: 'x'.repeat(900),
        httpStatus: 500,
        resposta: { html: 'y'.repeat(9_000) },
      }),
      contexto,
    );

    const { data } = create.mock.calls[0][0];
    expect(data.mensagem).toHaveLength(500);
    expect(data.resposta).toEqual({
      truncado: true,
      inicio: expect.any(String),
    });
    expect(data.resposta.inicio).toHaveLength(4_000);
  });

  it('não coloca o documento no log de texto', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');

    await service.registrar(recusa, contexto);

    const linha = String(warn.mock.calls[0][0]);
    expect(linha).toContain('[BASE:HERTZ] [clubgas] CARTAO_VIRTUAL');
    expect(linha).toContain('userId=42');
    expect(linha).not.toContain('12345678909');
  });

  it('não lança quando a gravação falha', async () => {
    create.mockRejectedValue(new Error('banco fora do ar'));

    await expect(service.registrar(recusa, contexto)).resolves.toBeUndefined();
  });

  it('tratar() registra e devolve a exceção HTTP do erro do Clubgas', async () => {
    const http = await service.tratar(recusa, contexto);

    expect(create).toHaveBeenCalledTimes(1);
    expect(http).toBeInstanceOf(HttpException);
    expect((http as HttpException).getResponse()).toEqual({
      statusCode: 422,
      code: 'CLUBGAS_CARTAO_RECUSADO',
      message: 'Não foi possível gerar seu cartão virtual.',
    });
  });

  it('tratar() devolve qualquer outro erro como veio, sem registrar', async () => {
    const outro = new Error('falha do Prisma');

    await expect(service.tratar(outro, contexto)).resolves.toBe(outro);
    expect(create).not.toHaveBeenCalled();
  });
});

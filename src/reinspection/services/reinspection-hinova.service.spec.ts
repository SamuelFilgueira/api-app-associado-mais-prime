import { BadRequestException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import {
  ReinspectionHinovaEnvioOrigem,
  ReinspectionHinovaEnvioStatus,
} from '@prisma/client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { ReinspectionHinovaRepository } from 'src/reinspection/repositories/reinspection-hinova.repository';
import { ReinspectionHinovaLoteService } from 'src/reinspection/services/reinspection-hinova-lote.service';
import { ReinspectionHinovaService } from 'src/reinspection/services/reinspection-hinova.service';
import { PrismaRevistoriaMemoria } from 'src/reinspection/testing/prisma-revistoria.memoria';

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    promises: { ...real.promises, readFile: jest.fn() },
  };
});

type Foto = {
  id: number;
  nomeArquivo: string;
  codigoTipo: number | null;
  url: string | null;
  sentToHinova: boolean;
};

const foto = (id: number, extra: Partial<Foto> = {}): Foto => ({
  id,
  nomeArquivo: `revistoria_ordem${id}_1.jpg`,
  codigoTipo: 1,
  url: `uploads/reinspection/${id}.jpg`,
  sentToHinova: false,
  ...extra,
});

describe('ReinspectionHinovaService', () => {
  let banco: PrismaRevistoriaMemoria;
  let prisma: {
    reinspection: { update: jest.SpyInstance };
    reinspectionPhoto: { update: jest.SpyInstance };
    reinspectionHinovaEnvio: { create: jest.SpyInstance };
  };
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let service: ReinspectionHinovaService;
  const readFile = fs.readFile as jest.Mock;

  /**
   * Grava a revistoria 10 (veículo de um associado MAIS_PRIME) com as fotos
   * informadas; o próximo id gerado — o do registro de envio — é 77.
   */
  function revistoria(fotos: Foto[], status = 'APROVADA'): void {
    const dono = banco.comUsuario({ id: 500, baseOrigin: 'MAIS_PRIME' });
    const veiculo = banco.comVeiculo({ id: 501, userId: dono.id });
    banco.comRevistoria({
      id: 10,
      userVehicleId: veiculo.id,
      status,
      codigoVeiculo: 555,
    });
    for (const f of fotos) banco.comFoto({ ...f, reinspectionId: 10 });
    banco.definirProximoId(77);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    banco = new PrismaRevistoriaMemoria();
    prisma = {
      reinspection: { update: jest.spyOn(banco.reinspection, 'update') },
      reinspectionPhoto: {
        update: jest.spyOn(banco.reinspectionPhoto, 'update'),
      },
      reinspectionHinovaEnvio: {
        create: jest.spyOn(banco.reinspectionHinovaEnvio, 'create'),
      },
    };
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    readFile.mockResolvedValue(Buffer.from('img'));
    service = new ReinspectionHinovaService(
      new ReinspectionHinovaRepository(banco.comoPrisma()),
      new ReinspectionHinovaLoteService(sgaAuth as unknown as SgaAuthService),
    );
  });

  const opcoesAprovacao = {
    origem: ReinspectionHinovaEnvioOrigem.APROVACAO,
  };

  it('lança 404 quando a revistoria não existe', async () => {
    await expect(service.enviarFotos(1, opcoesAprovacao)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('bloqueia reenvio manual fora de APROVADA/FINALIZADA', async () => {
    revistoria([foto(1)], 'EM_ANALISE');
    await expect(
      service.enviarFotos(10, {
        origem: ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('retorna null e não chama a Hinova quando não há foto pendente', async () => {
    revistoria([foto(1, { sentToHinova: true })]);
    const resultado = await service.enviarFotos(10, opcoesAprovacao);
    expect(resultado).toBeNull();
    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    expect(prisma.reinspectionHinovaEnvio.create).not.toHaveBeenCalled();
  });

  it('envia só as fotos pendentes e marca ENVIADA quando todas são inseridas', async () => {
    revistoria([foto(1, { sentToHinova: true }), foto(2)]);
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 200,
      data: [{ nome_arquivo: 'revistoria_ordem2_1.jpg', situacao: 'Inserido' }],
    });

    const resultado = await service.enviarFotos(10, opcoesAprovacao);

    const config = sgaAuth.executeRequestWithAuth.mock.calls[0][1];
    expect(config.data.foto).toHaveLength(1);
    expect(config.data.foto[0].nome_arquivo).toBe('revistoria_ordem2_1.jpg');
    expect(config.data.codigo_veiculo).toBe(555);
    expect(config.timeout).toBe(60_000);

    expect(resultado?.status).toBe(ReinspectionHinovaEnvioStatus.ENVIADA);
    expect(resultado?.totalInseridas).toBe(1);
    expect(resultado?.envioId).toBe(77);

    const log = prisma.reinspectionHinovaEnvio.create.mock.calls[0][0].data;
    expect(log).toMatchObject({
      reinspectionId: 10,
      origem: 'APROVACAO',
      status: 'ENVIADA',
      baseOrigin: 'MAIS_PRIME',
      totalFotos: 1,
      totalInseridas: 1,
      totalFalhas: 0,
      httpStatus: 200,
      photoIds: [2],
    });

    const updateFoto = prisma.reinspectionPhoto.update.mock.calls[0][0];
    expect(updateFoto.where).toEqual({ id: 2 });
    expect(updateFoto.data).toMatchObject({
      sentToHinova: true,
      hinovaSituacao: 'Inserido',
      hinovaUltimoErro: null,
    });
    expect(prisma.reinspection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hinovaEnvioStatus: 'ENVIADA' }),
      }),
    );
  });

  it('registra FALHA quando a Hinova responde HTTP >= 400 e não lança', async () => {
    revistoria([foto(1)]);
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 403,
      data: { mensagem: 'bloqueado' },
    });

    const resultado = await service.enviarFotos(10, opcoesAprovacao);

    expect(resultado?.status).toBe(ReinspectionHinovaEnvioStatus.FALHA);
    expect(resultado?.httpStatus).toBe(403);
    expect(resultado?.errorMessage).toContain('HTTP 403');
    const log = prisma.reinspectionHinovaEnvio.create.mock.calls[0][0].data;
    expect(log.status).toBe('FALHA');
    expect(log.responseBody).toEqual({ raw: '{"mensagem":"bloqueado"}' });
    const updateFoto = prisma.reinspectionPhoto.update.mock.calls[0][0];
    expect(updateFoto.data.hinovaUltimoErro).toContain('HTTP 403');
    expect(updateFoto.data.sentToHinova).toBeUndefined();
  });

  it('registra FALHA quando a chamada lança (timeout/rede)', async () => {
    revistoria([foto(1)]);
    sgaAuth.executeRequestWithAuth.mockRejectedValue(
      new Error('timeout of 60000ms exceeded'),
    );

    const resultado = await service.enviarFotos(10, opcoesAprovacao);

    expect(resultado?.status).toBe('FALHA');
    expect(resultado?.httpStatus).toBeNull();
    expect(resultado?.errorMessage).toContain('timeout');
    expect(prisma.reinspectionHinovaEnvio.create).toHaveBeenCalledTimes(1);
  });

  it('envia as fotos legíveis e registra erro individual na foto sem arquivo', async () => {
    revistoria([foto(1), foto(2, { url: null })]);
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 200,
      data: [{ nome_arquivo: 'revistoria_ordem1_1.jpg', situacao: 'Inserido' }],
    });

    const resultado = await service.enviarFotos(10, opcoesAprovacao);

    expect(
      sgaAuth.executeRequestWithAuth.mock.calls[0][1].data.foto,
    ).toHaveLength(1);
    expect(resultado?.status).toBe('PARCIAL');
    expect(resultado?.hinovaEnvioStatus).toBe('PARCIAL');
    const semArquivo = resultado?.fotos.find((f) => f.photoId === 2);
    expect(semArquivo?.erro).toContain('sem URL local');
  });

  it('registra FALHA sem chamar a Hinova quando nenhuma foto pôde ser lida', async () => {
    revistoria([foto(1)]);
    readFile.mockRejectedValue(new Error('ENOENT'));

    const resultado = await service.enviarFotos(10, opcoesAprovacao);

    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    expect(resultado?.status).toBe('FALHA');
    expect(resultado?.errorMessage).toContain('Nenhuma foto pôde ser lida');
    expect(resultado?.fotos[0].erro).toContain('ENOENT');
  });

  it('casa nomes repetidos na ordem de envio e marca foto sem retorno', async () => {
    revistoria([
      foto(1, { nomeArquivo: 'x.jpg' }),
      foto(2, { nomeArquivo: 'x.jpg' }),
      foto(3, { nomeArquivo: 'y.jpg' }),
    ]);
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 200,
      data: [
        { nome_arquivo: 'x.jpg', situacao: 'Inserido' },
        { nome_arquivo: 'x.jpg', situacao: 'Erro: duplicada' },
      ],
    });

    const resultado = await service.enviarFotos(10, opcoesAprovacao);

    const porId = new Map(resultado?.fotos.map((f) => [f.photoId, f]));
    expect(porId.get(1)?.inserida).toBe(true);
    expect(porId.get(2)?.inserida).toBe(false);
    expect(porId.get(2)?.situacao).toBe('Erro: duplicada');
    expect(porId.get(3)?.erro).toContain('não retornou resultado');
  });

  it('reenvio manual com photoIds de outra revistoria é rejeitado', async () => {
    revistoria([foto(1)]);
    await expect(
      service.enviarFotos(10, {
        origem: ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL,
        photoIds: [1, 99],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('reenvio manual com forcar inclui fotos já enviadas e grava o usuário do painel', async () => {
    revistoria([foto(1, { sentToHinova: true })], 'FINALIZADA');
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 200,
      data: [{ nome_arquivo: 'revistoria_ordem1_1.jpg', situacao: 'Inserido' }],
    });

    await service.enviarFotos(10, {
      origem: ReinspectionHinovaEnvioOrigem.REENVIO_MANUAL,
      forcar: true,
      adminPanelUserId: 5,
      adminPanelUserEmail: 'analista@exemplo.com',
    });

    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
    const log = prisma.reinspectionHinovaEnvio.create.mock.calls[0][0].data;
    expect(log).toMatchObject({
      origem: 'REENVIO_MANUAL',
      adminPanelUserId: 5,
      adminPanelUserEmail: 'analista@exemplo.com',
    });
  });
});

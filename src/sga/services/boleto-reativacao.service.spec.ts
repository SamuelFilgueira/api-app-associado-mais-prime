import { NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { SgaService } from 'src/sga/services/sga.service';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import {
  BoletoReativacaoDefinitivoError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';
import { JOB_ID_PREFIXO_RETRY_BOLETO } from 'src/sga/config/boleto-reativacao-retry.config';

const HORA_MS = 3_600_000;

function revistoria(extra: Record<string, unknown> = {}) {
  return {
    id: 10,
    status: 'APROVADA',
    codigoVeiculo: 777,
    boletoStatus: 'NAO_GERADO',
    boletoTentativas: 0,
    boletoNossoNumero: null,
    boletoUltimaTentativaEm: null,
    boletoRetryInicioEm: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    userVehicle: {
      id: 5,
      chassi: 'CHASSI123',
      plate: 'ABC1D23',
      user: { cpf: '529.982.247-25', baseOrigin: 'MAIS_PRIME' },
    },
    ...extra,
  };
}

function amanhaBR(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

describe('BoletoReativacaoService', () => {
  let prisma: {
    reinspection: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let sgaService: {
    criarBoletoReativacao: jest.Mock;
    buscarDadosAssociadoParaBoleto: jest.Mock;
    registrarPagamentoBoleto: jest.Mock;
    concluirBoletoReativacao: jest.Mock;
  };
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let mail: {
    sendRevistoriaAprovadaEmail: jest.Mock;
    sendRevistoriaAprovadaSemBoletoEmail: jest.Mock;
  };
  let queue: { add: jest.Mock };
  let service: BoletoReativacaoService;

  beforeEach(() => {
    prisma = {
      reinspection: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    sgaService = {
      criarBoletoReativacao: jest.fn(),
      buscarDadosAssociadoParaBoleto: jest.fn().mockResolvedValue({
        codigoAssociado: 1,
        nome: 'Fulano',
        telefoneCelular: '31999999999',
      }),
      registrarPagamentoBoleto: jest.fn().mockResolvedValue(undefined),
      concluirBoletoReativacao: jest
        .fn()
        .mockResolvedValue({ pollerAgendado: true, suriEnviada: true }),
    };
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    mail = {
      sendRevistoriaAprovadaEmail: jest.fn().mockResolvedValue(undefined),
      sendRevistoriaAprovadaSemBoletoEmail: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue({}) };
    service = new BoletoReativacaoService(
      prisma as unknown as PrismaService,
      sgaService as unknown as SgaService,
      sgaAuth as unknown as SgaAuthService,
      mail as unknown as MailService,
      queue as unknown as Queue,
    );
  });

  const semBoletoNoSga = () =>
    sgaAuth.executeRequestWithAuth.mockResolvedValue({ status: 200, data: [] });

  const ultimoUpdate = () =>
    prisma.reinspection.update.mock.calls[
      prisma.reinspection.update.mock.calls.length - 1
    ][0].data;

  it('lança 404 quando a revistoria não existe', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(null);
    await expect(service.processar(1, { origem: 'APROVACAO' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('não faz nada quando o boleto já foi gerado', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(
      revistoria({ boletoStatus: 'GERADO', boletoNossoNumero: '123' }),
    );
    const r = await service.processar(10, { origem: 'RETRY' });
    expect(r.pulado).toBe(true);
    expect(r.nossoNumero).toBe('123');
    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    expect(sgaService.criarBoletoReativacao).not.toHaveBeenCalled();
    expect(prisma.reinspection.update).not.toHaveBeenCalled();
  });

  it.each(['RETRY', 'MANUAL'] as const)(
    'origem %s em revistoria NAO_GERADO (aprovada antes do fluxo) não cria boleto',
    async (origem) => {
      prisma.reinspection.findUnique.mockResolvedValue(revistoria());

      const r = await service.processar(10, { origem });

      expect(r.pulado).toBe(true);
      expect(r.status).toBe('NAO_GERADO');
      expect(r.erro).toContain('antes do fluxo');
      expect(prisma.reinspection.updateMany).not.toHaveBeenCalled();
      expect(prisma.reinspection.update).not.toHaveBeenCalled();
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(sgaService.criarBoletoReativacao).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(mail.sendRevistoriaAprovadaEmail).not.toHaveBeenCalled();
      expect(mail.sendRevistoriaAprovadaSemBoletoEmail).not.toHaveBeenCalled();
    },
  );

  it('reconciliarPendentes ignora NAO_GERADO e FALHA: só PENDENTE_RETRY entra na fila', async () => {
    await service.reconciliarPendentes();
    expect(prisma.reinspection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { boletoStatus: 'PENDENTE_RETRY' },
      }),
    );
  });

  it('tentativa concorrente perde o lock e sai sem tocar o SGA', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(revistoria());
    prisma.reinspection.updateMany.mockResolvedValue({ count: 0 });

    const r = await service.processar(10, { origem: 'APROVACAO' });

    expect(r.pulado).toBe(true);
    expect(r.status).toBe('NAO_GERADO');
    expect(prisma.reinspection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 10, boletoTentativas: 0 }),
      }),
    );
    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    expect(sgaService.criarBoletoReativacao).not.toHaveBeenCalled();
    expect(prisma.reinspection.update).not.toHaveBeenCalled();
  });

  it('placa ausente é falha definitiva: FALHA, e-mail para a cobrança, sem retry', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(
      revistoria({ userVehicle: { ...revistoria().userVehicle, plate: null } }),
    );
    const r = await service.processar(10, { origem: 'APROVACAO' });
    expect(r.status).toBe('FALHA');
    expect(r.erro).toContain('Placa');
    expect(ultimoUpdate().boletoStatus).toBe('FALHA');
    expect(mail.sendRevistoriaAprovadaSemBoletoEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendRevistoriaAprovadaEmail).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('cadastra pela API quando o SGA não tem boleto de reativação aberto e manda o e-mail de aprovação', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(revistoria());
    semBoletoNoSga();
    sgaService.criarBoletoReativacao.mockResolvedValue({
      nossoNumero: '555',
      linkBoleto: 'https://sga/boleto/555',
      suriEnviada: true,
    });

    const r = await service.processar(10, {
      origem: 'APROVACAO',
      debugId: 'dbg',
    });

    const consulta = sgaAuth.executeRequestWithAuth.mock.calls[0][1];
    expect(consulta.url).toContain('/listar/boleto-associado-veiculo');
    expect(consulta.data.codigo_veiculo).toBe(777);
    expect(sgaService.criarBoletoReativacao).toHaveBeenCalledWith(
      5,
      'ABC1D23',
      'dbg',
      { reinspectionId: 10 },
    );
    expect(r.status).toBe('GERADO');
    expect(r.adotado).toBe(false);
    expect(r.nossoNumero).toBe('555');
    expect(r.suriEnviada).toBe(true);
    expect(r.emailEnviado).toBe(true);
    expect(ultimoUpdate()).toMatchObject({
      boletoStatus: 'GERADO',
      boletoTentativas: 1,
      boletoNossoNumero: '555',
      boletoOrigem: 'CRIADO_APP',
      boletoUltimoErro: null,
    });
    expect(mail.sendRevistoriaAprovadaEmail).toHaveBeenCalledWith(
      'CHASSI123',
      'ABC1D23',
      'dbg',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('adota boleto de reativação em aberto já criado no SGA em vez de cadastrar outro', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(revistoria());
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 200,
      data: [
        {
          // mensalidade em aberto: outro tipo, nunca adotar
          nosso_numero: 1,
          codigo_situacao_boleto: 2,
          codigo_tipo_boleto: 1,
          data_vencimento_original: amanhaBR(),
          codigo_veiculo: 777,
        },
        {
          // reativação já paga: não é candidata
          nosso_numero: 2,
          codigo_situacao_boleto: 1,
          codigo_tipo_boleto: 2,
          data_vencimento_original: amanhaBR(),
          codigo_veiculo: 777,
        },
        {
          nosso_numero: 3,
          codigo_situacao_boleto: '2',
          codigo_tipo_boleto: '2',
          data_vencimento_original: amanhaBR(),
          link_boleto: 'https://sga/boleto/3',
          linha_digitavel: '0001',
          veiculos: [{ codigo_veiculo: '777' }],
        },
      ],
    });

    const r = await service.processar(10, { origem: 'APROVACAO' });

    expect(sgaService.criarBoletoReativacao).not.toHaveBeenCalled();
    expect(sgaService.registrarPagamentoBoleto).toHaveBeenCalledWith(
      expect.objectContaining({
        userVehicleId: 5,
        reinspectionId: 10,
        nossoNumero: '3',
        linkBoleto: 'https://sga/boleto/3',
        linhaDigitavel: '0001',
      }),
    );
    expect(sgaService.concluirBoletoReativacao).toHaveBeenCalledWith(
      expect.objectContaining({
        nossoNumero: '3',
        codigoVeiculo: '777',
        baseOrigin: 'MAIS_PRIME',
      }),
    );
    expect(r.status).toBe('GERADO');
    expect(r.adotado).toBe(true);
    expect(ultimoUpdate().boletoOrigem).toBe('ADOTADO_SGA');
    expect(mail.sendRevistoriaAprovadaEmail).toHaveBeenCalledTimes(1);
  });

  it('instabilidade do SGA na consulta: PENDENTE_RETRY e job agendado para daqui a 5 min', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(revistoria());
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 503,
      data: 'indisponível',
    });

    const antes = Date.now();
    const r = await service.processar(10, { origem: 'APROVACAO' });

    expect(r.status).toBe('PENDENTE_RETRY');
    expect(r.tentativas).toBe(1);
    expect(r.erro).toContain('HTTP 503');
    expect(r.proximaTentativaEm!.getTime()).toBeGreaterThanOrEqual(
      antes + 5 * 60_000 - 50,
    );
    const update = ultimoUpdate();
    expect(update.boletoStatus).toBe('PENDENTE_RETRY');
    expect(update.boletoRetryInicioEm).toBeInstanceOf(Date);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [nome, data, opts] = queue.add.mock.calls[0];
    expect(nome).toBe('retry-boleto-reativacao');
    expect(data).toEqual({ reinspectionId: 10, debugId: undefined });
    expect(opts.jobId).toBe(`${JOB_ID_PREFIXO_RETRY_BOLETO}10-2`);
    expect(opts.delay).toBeGreaterThan(4 * 60_000);
    expect(opts.delay).toBeLessThanOrEqual(5 * 60_000);
    expect(mail.sendRevistoriaAprovadaEmail).not.toHaveBeenCalled();
    expect(mail.sendRevistoriaAprovadaSemBoletoEmail).not.toHaveBeenCalled();
  });

  it('timeout/rede no cadastro também é instabilidade (retry)', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(revistoria());
    semBoletoNoSga();
    sgaService.criarBoletoReativacao.mockRejectedValue(
      new BoletoReativacaoInstabilidadeError(
        'boleto/cadastrar: falha na chamada ao SGA (timeout of 60000ms exceeded)',
        'boleto/cadastrar',
      ),
    );
    const r = await service.processar(10, { origem: 'APROVACAO' });
    expect(r.status).toBe('PENDENTE_RETRY');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('retry mantém a janela: continua PENDENTE_RETRY enquanto não esgotar', async () => {
    const inicio = new Date(Date.now() - 2 * HORA_MS);
    prisma.reinspection.findUnique.mockResolvedValue(
      revistoria({
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 24,
        boletoRetryInicioEm: inicio,
        boletoUltimaTentativaEm: new Date(),
      }),
    );
    sgaAuth.executeRequestWithAuth.mockRejectedValue(new Error('ECONNRESET'));

    const r = await service.processar(10, { origem: 'RETRY' });

    expect(r.status).toBe('PENDENTE_RETRY');
    expect(r.tentativas).toBe(25);
    expect(ultimoUpdate().boletoRetryInicioEm).toEqual(inicio);
    expect(queue.add.mock.calls[0][2].jobId).toBe(
      `${JOB_ID_PREFIXO_RETRY_BOLETO}10-26`,
    );
  });

  it('janela de retry esgotada: FALHA, e-mail para a cobrança e sem novo job', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(
      revistoria({
        boletoStatus: 'PENDENTE_RETRY',
        boletoTentativas: 288,
        boletoRetryInicioEm: new Date(Date.now() - 25 * HORA_MS),
        boletoUltimaTentativaEm: new Date(),
      }),
    );
    sgaAuth.executeRequestWithAuth.mockResolvedValue({ status: 502, data: '' });

    const r = await service.processar(10, { origem: 'RETRY' });

    expect(r.status).toBe('FALHA');
    expect(r.erro).toContain('Janela de retry esgotada');
    expect(ultimoUpdate()).toMatchObject({
      boletoStatus: 'FALHA',
      boletoRetryInicioEm: null,
    });
    expect(mail.sendRevistoriaAprovadaSemBoletoEmail).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('tentativa manual reinicia a janela mesmo com retry antigo esgotado', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(
      revistoria({
        boletoStatus: 'FALHA',
        boletoTentativas: 300,
        boletoRetryInicioEm: null,
      }),
    );
    sgaAuth.executeRequestWithAuth.mockResolvedValue({ status: 503, data: '' });

    const r = await service.processar(10, { origem: 'MANUAL' });

    expect(r.status).toBe('PENDENTE_RETRY');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('erro definitivo do cadastro (ex.: placa inexistente no SGA): FALHA + e-mail, sem retry', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(revistoria());
    semBoletoNoSga();
    sgaService.criarBoletoReativacao.mockRejectedValue(
      new BoletoReativacaoDefinitivoError(
        'produto-vinculado-veiculo: SGA respondeu HTTP 404',
        'produto-vinculado-veiculo',
        404,
      ),
    );

    const r = await service.processar(10, { origem: 'APROVACAO' });

    expect(r.status).toBe('FALHA');
    expect(r.erro).toContain('HTTP 404');
    expect(mail.sendRevistoriaAprovadaSemBoletoEmail).toHaveBeenCalledWith(
      'CHASSI123',
      'ABC1D23',
      expect.stringContaining('HTTP 404'),
      undefined,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('404 na listagem de boletos é "nenhum boleto", não instabilidade', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(revistoria());
    sgaAuth.executeRequestWithAuth.mockResolvedValue({ status: 404, data: {} });
    sgaService.criarBoletoReativacao.mockResolvedValue({
      nossoNumero: '9',
      linkBoleto: null,
      suriEnviada: false,
    });
    const r = await service.processar(10, { origem: 'APROVACAO' });
    expect(r.status).toBe('GERADO');
    expect(sgaService.criarBoletoReativacao).toHaveBeenCalledTimes(1);
  });

  it('sem codigoVeiculo na revistoria não consulta o SGA e vai direto ao cadastro', async () => {
    prisma.reinspection.findUnique.mockResolvedValue(
      revistoria({ codigoVeiculo: null }),
    );
    sgaService.criarBoletoReativacao.mockResolvedValue({
      nossoNumero: '9',
      linkBoleto: null,
      suriEnviada: false,
    });
    await service.processar(10, { origem: 'APROVACAO' });
    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    expect(sgaService.criarBoletoReativacao).toHaveBeenCalledTimes(1);
  });

  it('reconciliarPendentes garante um job para cada PENDENTE_RETRY', async () => {
    prisma.reinspection.findMany.mockResolvedValue([
      {
        id: 1,
        boletoTentativas: 2,
        boletoProximaTentativaEm: new Date(Date.now() + 60_000),
      },
      { id: 2, boletoTentativas: 0, boletoProximaTentativaEm: null },
    ]);
    const r = await service.reconciliarPendentes();
    expect(r).toEqual({ pendentes: 2, agendados: 2 });
    expect(queue.add.mock.calls[0][2].jobId).toBe(
      `${JOB_ID_PREFIXO_RETRY_BOLETO}1-3`,
    );
    expect(queue.add.mock.calls[1][2].jobId).toBe(
      `${JOB_ID_PREFIXO_RETRY_BOLETO}2-1`,
    );
  });
});

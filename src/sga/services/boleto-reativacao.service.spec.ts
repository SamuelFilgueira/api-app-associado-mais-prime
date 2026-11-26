import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BoletoReativacaoService } from 'src/sga/services/boleto-reativacao.service';
import {
  BoletoReativacaoDefinitivoError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';
import { BoletoAdocaoService } from 'src/sga/services/boleto-adocao.service';
import { BoletoCriacaoService } from 'src/sga/services/boleto-criacao.service';
import { BoletoDesfechoService } from 'src/sga/services/boleto-desfecho.service';
import { BoletoObtencaoService } from 'src/sga/services/boleto-obtencao.service';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';

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

/**
 * Caracterização do boleto de reativação pela fachada usada pelo módulo de
 * revistoria. As dependências reais (caso de uso, repositório, adoção e
 * client do SGA) são montadas sobre os mesmos mocks de sempre: `prisma`,
 * `sgaAuth` (chamadas HTTP ao SGA), `mail` e `sgaService` — este no papel do
 * `BoletoCriacaoService`, que herdou os métodos de boleto do `SgaService`.
 */
describe('BoletoReativacaoService', () => {
  let prisma: {
    reinspection: {
      findUnique: jest.Mock;
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
  let service: BoletoReativacaoService;

  beforeEach(() => {
    prisma = {
      reinspection: {
        findUnique: jest.fn(),
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
    const client = new SgaBoletoClient(
      sgaAuth as unknown as SgaAuthService,
      {} as HinovaClient,
    );
    jest
      .spyOn(client, 'buscarDadosAssociadoParaBoleto')
      .mockImplementation(sgaService.buscarDadosAssociadoParaBoleto);
    const criacao = sgaService as unknown as BoletoCriacaoService;
    const revistorias = new BoletoReativacaoRepository(
      prisma as unknown as PrismaService,
    );
    service = new BoletoReativacaoService(
      new GerarBoletoReativacaoService(
        revistorias,
        new BoletoObtencaoService(
          new BoletoAdocaoService(client, criacao),
          criacao,
        ),
        new BoletoDesfechoService(revistorias, mail as unknown as MailService),
      ),
      revistorias,
    );
  });

  const semBoletoNoSga = () =>
    sgaAuth.executeRequestWithAuth.mockResolvedValue({ status: 200, data: [] });

  /** Gravação do desfecho (a primeira `updateMany` é a reivindicação do lease). */
  const ultimoUpdate = () =>
    prisma.reinspection.updateMany.mock.calls[
      prisma.reinspection.updateMany.mock.calls.length - 1
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
    expect(prisma.reinspection.updateMany).not.toHaveBeenCalled();
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
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(sgaService.criarBoletoReativacao).not.toHaveBeenCalled();
      expect(mail.sendRevistoriaAprovadaEmail).not.toHaveBeenCalled();
      expect(mail.sendRevistoriaAprovadaSemBoletoEmail).not.toHaveBeenCalled();
    },
  );

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
    // Só a tentativa de reivindicar o lease: nenhum desfecho gravado.
    expect(prisma.reinspection.updateMany).toHaveBeenCalledTimes(1);
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
    expect(ultimoUpdate().boletoProximaTentativaEm).toBeNull();
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
    expect(ultimoUpdate().boletoProximaTentativaEm).toBeNull();
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

  it('instabilidade do SGA na consulta: PENDENTE_RETRY com a próxima tentativa gravada para daqui a 5 min', async () => {
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
    // O retry não é mais um job atrasado por revistoria: a varredura lê
    // `boletoProximaTentativaEm` (e o lease é solto para ela poder tentar).
    expect(update.boletoProximaTentativaEm).toEqual(r.proximaTentativaEm);
    expect(update.boletoLeaseAte).toBeNull();
    expect(update.boletoLeaseDono).toBeNull();
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
    expect(ultimoUpdate().boletoProximaTentativaEm).toBeInstanceOf(Date);
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
    expect(ultimoUpdate().boletoTentativas).toBe(25);
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
    expect(ultimoUpdate().boletoProximaTentativaEm).toBeNull();
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
    expect(ultimoUpdate().boletoStatus).toBe('PENDENTE_RETRY');
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
    expect(ultimoUpdate().boletoStatus).toBe('FALHA');
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

  it('listarPendentes devolve PENDENTE_RETRY e FALHA com chassi e placa', async () => {
    prisma.reinspection.findMany.mockResolvedValue([
      {
        id: 1,
        boletoStatus: 'FALHA',
        userVehicle: { chassi: 'C1', plate: 'P1' },
      },
    ]);

    const pendentes = await service.listarPendentes();

    expect(prisma.reinspection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { boletoStatus: { in: ['PENDENTE_RETRY', 'FALHA'] } },
      }),
    );
    expect(pendentes).toEqual([
      { id: 1, boletoStatus: 'FALHA', chassi: 'C1', plate: 'P1' },
    ]);
  });
});

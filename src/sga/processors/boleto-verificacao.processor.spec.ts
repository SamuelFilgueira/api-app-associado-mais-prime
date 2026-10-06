import { Job, Queue } from 'bullmq';
import { BoletoVerificacaoProcessor } from './boleto-verificacao.processor';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import {
  BoletoVerificacaoConfig,
  INTERVALO_BASE_MS,
} from 'src/sga/config/boleto-verificacao.config';

const MIN = 60_000;
const DIA = 86_400_000;

/**
 * Caracterização do poller de boleto de reativação: cadência por idade,
 * encerramentos (idade máxima, cancelado/excluído) e o fluxo de pagamento,
 * que permanece o mesmo de antes.
 */
describe('BoletoVerificacaoProcessor', () => {
  const agora = Date.UTC(2026, 9, 6, 12, 0, 0);
  const config: BoletoVerificacaoConfig = {
    intervaloBaseMs: INTERVALO_BASE_MS,
    maxDias: 30,
    intervaloApos24hMin: 10,
    intervaloApos7dMin: 60,
    espacamentoMs: 0,
  };

  let processor: BoletoVerificacaoProcessor;
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let prisma: {
    reinspectionPayment: { findUnique: jest.Mock; upsert: jest.Mock };
    userVehicle: { findUnique: jest.Mock };
  };
  let queue: { removeRepeatableByKey: jest.Mock; getRepeatableJobs: jest.Mock };
  let mail: { sendBoletoRevistoriaPago: jest.Mock };
  let suri: { enviarTemplate: jest.Mock };

  const job = () =>
    ({
      data: {
        userVehicleId: 7,
        nosso_numero: 123,
        codigo_veiculo: '55',
        codigo_associado: 9,
        baseOrigin: 'MAIS_PRIME',
        nome: 'Fulano de Tal',
        telefone_celular: '31999999999',
      },
      repeatJobKey: 'chave-123',
    }) as unknown as Job;

  const pagamento = (criadoHa: number, consultadoHa: number, pago = false) => ({
    pago,
    boletoCriadoEm: new Date(agora - criadoHa),
    updatedAt: new Date(agora - consultadoHa),
  });

  const sgaSituacao = (codigo: number) => ({
    status: 200,
    data: [{ nosso_numero: 123, codigo_situacao_boleto: codigo }],
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: agora });
    sgaAuth = {
      executeRequestWithAuth: jest.fn().mockResolvedValue(sgaSituacao(2)),
    };
    prisma = {
      reinspectionPayment: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      userVehicle: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ chassi: '9BWZZZ377VT004251', plate: 'ABC1D23' }),
      },
    };
    queue = {
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
    };
    mail = { sendBoletoRevistoriaPago: jest.fn().mockResolvedValue(undefined) };
    suri = { enviarTemplate: jest.fn().mockResolvedValue(undefined) };

    processor = new BoletoVerificacaoProcessor(
      sgaAuth as unknown as SgaAuthService,
      prisma as unknown as PrismaService,
      mail as unknown as MailService,
      suri as unknown as SuriNotificacaoService,
      queue as unknown as Queue,
    );
    Object.assign(processor, { config });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('cadência por idade do boleto', () => {
    it('boleto novo (< 24h): consulta o SGA em todo disparo e mantém o poller', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(60 * MIN, 2 * MIN),
      );

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
      expect(prisma.reinspectionPayment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ situacaoBoleto: '2', pago: false }),
        }),
      );
      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    });

    it('boleto com mais de 24h consultado há 3 min: pula o disparo sem chamar o SGA', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(2 * DIA, 3 * MIN),
      );

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(prisma.reinspectionPayment.upsert).not.toHaveBeenCalled();
      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    });

    it('boleto com mais de 24h consultado há 10 min: volta a consultar o SGA', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(2 * DIA, 10 * MIN),
      );

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
    });

    it('boleto com mais de 7 dias: consulta de hora em hora', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(10 * DIA, 30 * MIN),
      );
      await processor.process(job() as Job<never>);
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();

      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(10 * DIA, 60 * MIN),
      );
      await processor.process(job() as Job<never>);
      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
    });

    it('sem linha no banco (primeiro disparo): consulta o SGA normalmente', async () => {
      await processor.process(job() as Job<never>);
      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
    });
  });

  describe('encerramento do poller', () => {
    it('boleto além da idade máxima: encerra sem consultar o SGA', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(31 * DIA, 60 * MIN),
      );

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
    });

    it('cancelado (3) no SGA: persiste a situação e encerra sem reativar nada', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue(sgaSituacao(3));

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
      expect(prisma.reinspectionPayment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ situacaoBoleto: '3', pago: false }),
        }),
      );
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
      expect(mail.sendBoletoRevistoriaPago).not.toHaveBeenCalled();
    });

    it('excluído (999) no SGA: encerra o poller', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue(sgaSituacao(999));

      await processor.process(job() as Job<never>);

      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
    });
  });

  describe('fluxo de pagamento (inalterado)', () => {
    it('pago (1) no SGA: reativa veículo e associado, avisa a equipe e o associado, e encerra', async () => {
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });

      await processor.process(job() as Job<never>);

      const urls = sgaAuth.executeRequestWithAuth.mock.calls.map(
        (call) => call[1].url as string,
      );
      expect(urls).toHaveLength(3);
      expect(urls[0]).toContain('/processa-pdf/boleto');
      expect(urls[1]).toContain('/veiculo/alterar-situacao-para/1/55');
      expect(urls[2]).toContain('/associado/alterar-situacao-para/1/9');
      expect(prisma.reinspectionPayment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ situacaoBoleto: '1', pago: true }),
        }),
      );
      expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(1);
      expect(suri.enviarTemplate).toHaveBeenCalledTimes(1);
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
    });

    it('pago no banco com poller ainda ativo: consulta o SGA fora da cadência e conclui a reativação', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(2 * DIA, 1 * MIN, true),
      );
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(3);
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
    });

    it('processa-pdf sem situação: usa o fallback por veículo (2 consultas) e segue', async () => {
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockResolvedValueOnce({
          status: 200,
          data: [{ nosso_numero: '123', codigo_situacao_boleto: '2' }],
        });

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(2);
      expect(sgaAuth.executeRequestWithAuth.mock.calls[1][1].url).toContain(
        '/listar/boleto-associado-veiculo',
      );
      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    });
  });

  describe('onApplicationBootstrap', () => {
    it('encerra só os pollers de boletos além da idade máxima', async () => {
      queue.getRepeatableJobs.mockResolvedValue([
        {
          key: 'k-velho',
          name: 'verificar-boleto',
          id: 'boleto-verificacao-111',
        },
        {
          key: 'k-novo',
          name: 'verificar-boleto',
          id: 'boleto-verificacao-222',
        },
        { key: 'k-outro', name: 'outro-job', id: 'x' },
      ]);
      prisma.reinspectionPayment.findUnique.mockImplementation(
        ({ where }: { where: { nossoNumero: string } }) =>
          Promise.resolve(
            where.nossoNumero === '111'
              ? { boletoCriadoEm: new Date(agora - 40 * DIA) }
              : { boletoCriadoEm: new Date(agora - 1 * DIA) },
          ),
      );

      await processor.onApplicationBootstrap();

      expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(1);
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('k-velho');
    });

    it('falha no Redis não derruba o boot', async () => {
      queue.getRepeatableJobs.mockRejectedValue(new Error('redis fora'));
      await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});

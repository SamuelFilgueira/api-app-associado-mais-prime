import { Job, Queue, UnrecoverableError } from 'bullmq';
import { BoletoVerificacaoProcessor } from './boleto-verificacao.processor';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { PrismaService } from 'src/database/prisma.service';
import { MailService } from 'src/infra/mail/mail.service';
import { registroDeMetricas } from 'src/infra/observability/metricas';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import { FilaDeMortosService } from 'src/queue/fila-de-mortos.service';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';
import {
  BoletoVerificacaoConfig,
  INTERVALO_BASE_MS,
  JOB_AVISAR_BOLETO_PAGO,
  JOB_VERIFICAR_BOLETO,
} from 'src/sga/config/boleto-verificacao.config';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { AvisosBoletoPagoService } from 'src/sga/services/avisos-boleto-pago.service';
import { BoletoVerificacaoLegadoService } from 'src/sga/services/boleto-verificacao-legado.service';
import { BoletoVerificacaoVarreduraService } from 'src/sga/services/boleto-verificacao-varredura.service';
import { ReativacaoPosPagamentoService } from 'src/sga/services/reativacao-pos-pagamento.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';
import { VerificarPagamentoBoletoService } from 'src/sga/services/verificar-pagamento-boleto.service';

const MIN = 60_000;
const DIA = 86_400_000;

/**
 * Caracterização do poller ANTIGO de boleto de reativação (job repetível
 * por boleto, com o payload antigo): cadência por idade, encerramentos
 * (idade máxima, cancelado/excluído) e o fluxo de pagamento.
 *
 * O processor só delega; os casos de uso reais são montados sobre os mesmos
 * mocks de sempre (`sgaAuth`, `prisma`, `queue`, `mail`, `suri`). O que
 * mudou de lugar: os avisos de boleto pago (e-mail e WhatsApp) saíram do job
 * de verificação e passaram ao evento `boleto.pago` do outbox — os testes
 * entregam esse evento ao mesmo processor (`entregarAvisos`).
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
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    reinspectionPayment: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
      updateMany: jest.Mock;
    };
    userVehicle: { findUnique: jest.Mock };
  };
  let queue: {
    removeRepeatableByKey: jest.Mock;
    getJobSchedulers: jest.Mock;
    getJob: jest.Mock;
    upsertJobScheduler: jest.Mock;
  };
  let mail: { sendBoletoRevistoriaPago: jest.Mock };
  let suri: { enviarTemplateComResultado: jest.Mock };
  let filaDeMortos: { receber: jest.Mock };
  let outbox: { registrar: jest.Mock };
  let hinova: { invalidarAssociado: jest.Mock; invalidarBoletos: jest.Mock };

  const job = (dados: Record<string, unknown> = {}) =>
    ({
      name: JOB_VERIFICAR_BOLETO,
      data: {
        userVehicleId: 7,
        nosso_numero: 123,
        codigo_veiculo: '55',
        codigo_associado: 9,
        baseOrigin: 'MAIS_PRIME',
        nome: 'Fulano de Tal',
        telefone_celular: '31999999999',
        ...dados,
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
      // Transação interativa: o callback recebe o próprio mock.
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      // `SELECT ... FOR UPDATE SKIP LOCKED` da reserva da varredura.
      $queryRaw: jest.fn().mockResolvedValue([]),
      reinspectionPayment: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      userVehicle: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ chassi: '9BWZZZ377VT004251', plate: 'ABC1D23' }),
      },
    };
    queue = {
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    mail = { sendBoletoRevistoriaPago: jest.fn().mockResolvedValue(undefined) };
    suri = {
      enviarTemplateComResultado: jest
        .fn()
        .mockResolvedValue({ aceito: true, status: 200 }),
    };
    filaDeMortos = { receber: jest.fn() };
    outbox = { registrar: jest.fn().mockResolvedValue(undefined) };
    hinova = {
      invalidarAssociado: jest.fn().mockResolvedValue(undefined),
      invalidarBoletos: jest.fn().mockResolvedValue(undefined),
    };

    const client = new SgaBoletoClient(
      sgaAuth as unknown as SgaAuthService,
      hinova as unknown as HinovaClient,
    );
    const pagamentos = new PagamentoBoletoRepository(
      prisma as unknown as PrismaService,
      outbox as unknown as OutboxService,
    );
    const verificacao = new VerificarPagamentoBoletoService(
      client,
      pagamentos,
      new ReativacaoPosPagamentoService(client, pagamentos),
    );
    const legado = new BoletoVerificacaoLegadoService(
      pagamentos,
      verificacao,
      queue as unknown as Queue,
    );
    const varredura = new BoletoVerificacaoVarreduraService(
      pagamentos,
      verificacao,
    );
    for (const comConfig of [verificacao, legado, varredura]) {
      Object.assign(comConfig, { config });
    }

    processor = new BoletoVerificacaoProcessor(
      varredura,
      legado,
      new AvisosBoletoPagoService(
        pagamentos,
        mail as unknown as MailService,
        suri as unknown as SuriNotificacaoService,
      ),
      queue as unknown as Queue,
      filaDeMortos as unknown as FilaDeMortosService,
    );
  });

  /**
   * Entrega ao processor os eventos `boleto.pago` que a verificação gravou
   * no outbox — o que o despachante do outbox faz em produção. `linha` é o
   * pagamento como está no banco no momento da entrega.
   */
  const entregarAvisos = async (linha: Record<string, unknown> = {}) => {
    prisma.reinspectionPayment.findUnique.mockResolvedValue({
      id: 1,
      userVehicleId: 7,
      pago: true,
      pagoNotificadoEm: null,
      nomeAssociado: 'Fulano de Tal',
      telefoneAssociado: '31999999999',
      ...linha,
    });
    for (const [, evento] of outbox.registrar.mock.calls as Array<
      [unknown, { tipo: string; chave: string; payload: unknown }]
    >) {
      await processor.process({
        name: JOB_AVISAR_BOLETO_PAGO,
        data: evento.payload,
      } as Job<never>);
    }
  };

  const expirados = async (): Promise<number> => {
    const metrica = await registroDeMetricas
      .getSingleMetric('boleto_reativacao_total')!
      .get();
    return metrica.values
      .filter((v) => v.labels.evento === 'expirado')
      .reduce((soma, v) => soma + v.value, 0);
  };

  /** Dados gravados (`data`) pelas escritas condicionais em `updateMany`. */
  const marcadoresGravados = () =>
    prisma.reinspectionPayment.updateMany.mock.calls.map(
      ([args]: [{ data: Record<string, unknown> }]) => args.data,
    );

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
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');

      // Os avisos saem pelo evento `boleto.pago`, gravado junto com o
      // pagamento: um evento, um e-mail e um WhatsApp.
      expect(outbox.registrar).toHaveBeenCalledTimes(1);
      expect(outbox.registrar.mock.calls[0][1]).toMatchObject({
        tipo: 'boleto.pago',
        chave: '123',
      });
      await entregarAvisos();
      expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(1);
      expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(1);
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

    it('SGA recusa a reativação do veículo: o job falha e o poller segue ativo', async () => {
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValueOnce({
          status: 403,
          data: { mensagem: 'bloqueado' },
        });

      await expect(processor.process(job() as Job<never>)).rejects.toThrow(
        /HTTP 403 ao reativar o veículo 55/,
      );

      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
      // Nada foi marcado como feito nem encerrado.
      expect(marcadoresGravados()).toEqual([]);
    });

    it('reativação aceita grava o marcador `reativadoEm`', async () => {
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });

      await processor.process(job() as Job<never>);

      // Escritas condicionais: cada marcador só é gravado se ainda estiver
      // vazio (`updateMany` + contagem), em vez de um `update` às cegas.
      expect(prisma.reinspectionPayment.updateMany).toHaveBeenCalledWith({
        where: { nossoNumero: '123', reativadoEm: null },
        data: { reativadoEm: expect.any(Date) },
      });
      await entregarAvisos();
      expect(prisma.reinspectionPayment.updateMany).toHaveBeenCalledWith({
        where: { id: 1, pagoNotificadoEm: null },
        data: { pagoNotificadoEm: expect.any(Date) },
      });
    });

    it('reentrada após falha: não repete o e-mail nem a reativação já aceita', async () => {
      // A linha é lida uma vez só, com os marcadores junto.
      prisma.reinspectionPayment.findUnique.mockResolvedValue({
        ...pagamento(2 * DIA, 1 * MIN, true),
        pagoEm: new Date(agora - MIN),
        reativadoEm: new Date(agora - MIN),
        pagoNotificadoEm: new Date(agora - MIN),
      });
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });

      await processor.process(job() as Job<never>);

      const urls = sgaAuth.executeRequestWithAuth.mock.calls.map(
        (call) => call[1].url as string,
      );
      expect(
        urls.some((u) => u.includes('/veiculo/alterar-situacao-para')),
      ).toBe(false);
      // E-mail já enviado numa execução anterior: a nova entrega do evento
      // não reivindica o marcador e não envia de novo.
      prisma.reinspectionPayment.updateMany.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve({ count: 'pagoNotificadoEm' in where ? 0 : 1 }),
      );
      await entregarAvisos({ pagoNotificadoEm: new Date(agora - MIN) });
      expect(mail.sendBoletoRevistoriaPago).not.toHaveBeenCalled();
      // A data do pagamento é a da primeira detecção, não a da reentrada.
      expect(prisma.reinspectionPayment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ pagoEm: new Date(agora - MIN) }),
        }),
      );
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

  describe('base do job', () => {
    /** Base usada em cada chamada ao SGA (1º argumento). */
    const basesUsadas = () =>
      sgaAuth.executeRequestWithAuth.mock.calls.map(
        (call) => call[0] as unknown,
      );

    /** Leituras de `userVehicle` feitas só para descobrir a base. */
    const leiturasDaBase = () =>
      prisma.userVehicle.findUnique.mock.calls.filter(
        ([args]: [{ select: Record<string, unknown> }]) => !!args.select.user,
      );

    it('job com a base no payload: usa a do payload, sem consultar o banco', async () => {
      await processor.process(
        job({ baseOrigin: 'MAIS_PRIME_RS' }) as Job<never>,
      );

      expect(basesUsadas()).toEqual(['MAIS_PRIME_RS']);
      expect(leiturasDaBase()).toHaveLength(0);
    });

    it('job antigo, sem `baseOrigin`: rederiva a base do dono do veículo', async () => {
      prisma.userVehicle.findUnique.mockResolvedValue({
        user: { baseOrigin: 'MAIS_PRIME_RS' },
      });

      await processor.process(job({ baseOrigin: undefined }) as Job<never>);

      expect(leiturasDaBase()).toEqual([
        [
          {
            where: { id: 7 },
            select: { user: { select: { baseOrigin: true } } },
          },
        ],
      ]);
      expect(basesUsadas()).toEqual(['MAIS_PRIME_RS']);
    });

    it('base do payload fora das bases do deploy: vale a do banco', async () => {
      prisma.userVehicle.findUnique.mockResolvedValue({
        user: { baseOrigin: 'MAIS_PRIME' },
      });

      await processor.process(
        job({ baseOrigin: 'BASE_DESCONHECIDA' }) as Job<never>,
      );

      expect(basesUsadas()).toEqual(['MAIS_PRIME']);
    });

    it.each([
      ['veículo inexistente', null],
      ['usuário sem base', { user: { baseOrigin: null } }],
    ])(
      'sem base no payload nem no banco (%s): falha de vez, sem base padrão e sem tocar o SGA',
      async (_caso, veiculo) => {
        prisma.userVehicle.findUnique.mockResolvedValue(veiculo);

        const erro: unknown = await processor
          .process(job({ baseOrigin: undefined }) as Job<never>)
          .then(
            () => null,
            (e: unknown) => e,
          );

        // A base do processor converte o erro definitivo em
        // `UnrecoverableError`: o BullMQ não tenta de novo.
        expect(erro).toBeInstanceOf(UnrecoverableError);
        expect((erro as Error).message).toBe(
          new BaseNaoResolvidaError('x').message,
        );
        expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
        expect(prisma.reinspectionPayment.upsert).not.toHaveBeenCalled();
      },
    );

    it('boleto além da idade máxima encerra o poller mesmo sem base resolvível', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(31 * DIA, 60 * MIN),
      );
      prisma.userVehicle.findUnique.mockResolvedValue(null);

      await processor.process(job({ baseOrigin: undefined }) as Job<never>);

      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
      expect(leiturasDaBase()).toHaveLength(0);
    });
  });

  describe('pós-pagamento: nada encerra enquanto o SGA não aceitar as duas reativações', () => {
    it('SGA recusa a reativação do ASSOCIADO: o job falha, o poller segue e o veículo fica marcado', async () => {
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValueOnce({ status: 200, data: {} })
        .mockResolvedValueOnce({ status: 500, data: 'erro interno' });

      await expect(processor.process(job() as Job<never>)).rejects.toThrow(
        /HTTP 500 ao reativar o associado 9/,
      );

      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
      // Só o marcador do veículo: a verificação NÃO foi encerrada.
      expect(marcadoresGravados()).toEqual([{ reativadoEm: expect.any(Date) }]);
    });

    it('rodada seguinte à recusa do associado: não repete o veículo nem os avisos, conclui e encerra', async () => {
      // 1ª rodada: associado recusado.
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValueOnce({ status: 200, data: {} })
        .mockResolvedValueOnce({ status: 500, data: 'erro interno' });
      await expect(processor.process(job() as Job<never>)).rejects.toThrow();
      await entregarAvisos();

      // 2ª rodada: a linha já está paga, com o veículo reativado e o e-mail
      // enviado; o evento do outbox já existe (a chave é única no banco).
      prisma.reinspectionPayment.findUnique.mockResolvedValue({
        ...pagamento(60 * MIN, 2 * MIN, true),
        pagoEm: new Date(agora),
        reativadoEm: new Date(agora),
        pagoNotificadoEm: new Date(agora),
      });
      sgaAuth.executeRequestWithAuth.mockReset();
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });

      await processor.process(job() as Job<never>);

      const urls = sgaAuth.executeRequestWithAuth.mock.calls.map(
        (call) => call[1].url as string,
      );
      expect(urls).toHaveLength(2);
      expect(urls[1]).toContain('/associado/alterar-situacao-para/1/9');
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
      expect(marcadoresGravados()).toContainEqual({
        verificacaoEncerradaEm: expect.any(Date),
      });
      // Um e-mail e um WhatsApp no total, apesar das duas rodadas.
      expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(1);
      expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(1);
    });

    it('falha ao gravar o pagamento: o job falha antes de reativar ou avisar (sem persistir não há marcador)', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValueOnce(sgaSituacao(1));
      prisma.reinspectionPayment.upsert.mockRejectedValue(
        new Error('banco fora'),
      );

      await expect(processor.process(job() as Job<never>)).rejects.toThrow(
        'banco fora',
      );

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
      expect(outbox.registrar).not.toHaveBeenCalled();
      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    });

    it('o evento do outbox é gravado na MESMA transação do pagamento', async () => {
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });

      await processor.process(job() as Job<never>);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // `registrar` recebe o cliente da transação em que o upsert rodou.
      expect(outbox.registrar.mock.calls[0][0]).toBe(prisma);
      expect(outbox.registrar.mock.calls[0][1]).toEqual({
        tipo: 'boleto.pago',
        chave: '123',
        base: 'MAIS_PRIME',
        payload: { nossoNumero: '123' },
      });
    });

    it('boleto em aberto não gera evento', async () => {
      await processor.process(job() as Job<never>);
      expect(outbox.registrar).not.toHaveBeenCalled();
    });

    it('pagamento detectado e veículo reativado: invalida o cache das leituras do app', async () => {
      prisma.userVehicle.findUnique.mockResolvedValue({
        user: { cpf: '529.982.247-25', baseOrigin: 'MAIS_PRIME' },
      });
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });

      await processor.process(job() as Job<never>);

      expect(hinova.invalidarAssociado).toHaveBeenCalledTimes(2);
      expect(hinova.invalidarAssociado).toHaveBeenCalledWith(
        'MAIS_PRIME',
        '529.982.247-25',
      );
      expect(hinova.invalidarBoletos).toHaveBeenCalledWith(
        'MAIS_PRIME',
        expect.objectContaining({ codigo_veiculo: 55 }),
      );
    });

    it('a verificação de pagamento vai direto ao SGA, sem cache', async () => {
      await processor.process(job() as Job<never>);

      const [, consulta] = sgaAuth.executeRequestWithAuth.mock.calls[0];
      expect(consulta.url).toContain('/processa-pdf/boleto');
      expect(consulta.data).toEqual({ nosso_numero: 123 });
      expect(consulta.compartilharEmVoo).toBeUndefined();
    });
  });

  describe('varredura (boletos novos, sem job por boleto)', () => {
    const jobDaVarredura = () =>
      ({ name: 'varrer-boletos', data: {} }) as Job<never>;

    /** Linha do boleto como a varredura a lê do banco. */
    const linha = (extra: Record<string, unknown> = {}) => ({
      id: 1,
      userVehicleId: 7,
      nossoNumero: '123',
      pago: false,
      pagoEm: null,
      boletoCriadoEm: new Date(agora - 60 * MIN),
      updatedAt: new Date(agora - 2 * MIN),
      reativadoEm: null,
      pagoNotificadoEm: null,
      proximaConsultaEm: new Date(agora - MIN),
      verificacaoEncerradaEm: null,
      baseOrigin: 'MAIS_PRIME',
      codigoVeiculo: '55',
      codigoAssociado: 9,
      nomeAssociado: 'Fulano de Tal',
      telefoneAssociado: '31999999999',
      ...extra,
    });

    /** A rodada encontra este boleto vencido (e mais nenhum). */
    const comBoletoVencido = (registro: Record<string, unknown>) => {
      prisma.$queryRaw.mockReset();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: registro.id }])
        .mockResolvedValue([]);
      prisma.reinspectionPayment.findMany.mockResolvedValue([registro]);
    };

    it('boleto em aberto: consulta o SGA com os dados da linha e reagenda pela idade', async () => {
      comBoletoVencido(linha());

      await processor.process(jobDaVarredura());

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledTimes(1);
      expect(sgaAuth.executeRequestWithAuth.mock.calls[0][0]).toBe(
        'MAIS_PRIME',
      );
      // Reserva (10 min) e, depois da consulta, o horário de verdade (2 min).
      expect(marcadoresGravados()).toEqual([
        { proximaConsultaEm: new Date(agora + 10 * MIN) },
        { proximaConsultaEm: new Date(agora + 2 * MIN) },
      ]);
      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    });

    it('pago e reativado: encerra a linha (não há repetível para remover)', async () => {
      comBoletoVencido(linha());
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });

      await processor.process(jobDaVarredura());

      expect(marcadoresGravados()).toEqual([
        { proximaConsultaEm: new Date(agora + 10 * MIN) },
        { reativadoEm: expect.any(Date) },
        { verificacaoEncerradaEm: expect.any(Date) },
      ]);
      await entregarAvisos();
      expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(1);
      expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(1);
    });

    it('associado recusado: nada encerra, a rodada falha e a seguinte conclui — um e-mail e um WhatsApp no total', async () => {
      // 1ª rodada: pago, veículo reativado, associado recusado.
      comBoletoVencido(linha());
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValueOnce({ status: 200, data: {} })
        .mockResolvedValueOnce({ status: 500, data: 'erro interno' });

      await expect(processor.process(jobDaVarredura())).rejects.toThrow(
        /boleto 123: .*HTTP 500 ao reativar o associado 9/,
      );

      expect(marcadoresGravados()).toEqual([
        { proximaConsultaEm: new Date(agora + 10 * MIN) },
        { reativadoEm: expect.any(Date) },
        // Volta à varredura; `verificacaoEncerradaEm` NÃO foi gravado.
        { proximaConsultaEm: new Date(agora + 2 * MIN) },
      ]);
      await entregarAvisos();

      // 2ª rodada: a linha já está paga, com o veículo reativado e o e-mail
      // marcado. O evento do outbox já existe (chave única no banco).
      prisma.reinspectionPayment.updateMany.mockClear();
      sgaAuth.executeRequestWithAuth.mockReset();
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValue({ status: 200, data: {} });
      comBoletoVencido(
        linha({
          pago: true,
          pagoEm: new Date(agora),
          reativadoEm: new Date(agora),
          pagoNotificadoEm: new Date(agora),
        }),
      );

      await processor.process(jobDaVarredura());

      const urls = sgaAuth.executeRequestWithAuth.mock.calls.map(
        (call) => call[1].url as string,
      );
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain('/processa-pdf/boleto');
      expect(urls[1]).toContain('/associado/alterar-situacao-para/1/9');
      expect(marcadoresGravados()).toEqual([
        { proximaConsultaEm: new Date(agora + 10 * MIN) },
        { verificacaoEncerradaEm: expect.any(Date) },
      ]);
      expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(1);
      expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(1);
    });

    it('veículo recusado: nem o marcador do veículo é gravado, e a linha volta à varredura', async () => {
      comBoletoVencido(linha());
      sgaAuth.executeRequestWithAuth
        .mockResolvedValueOnce(sgaSituacao(1))
        .mockResolvedValueOnce({
          status: 403,
          data: { mensagem: 'bloqueado' },
        });

      await expect(processor.process(jobDaVarredura())).rejects.toThrow(
        /HTTP 403 ao reativar o veículo 55/,
      );

      expect(marcadoresGravados()).toEqual([
        { proximaConsultaEm: new Date(agora + 10 * MIN) },
        { proximaConsultaEm: new Date(agora + 2 * MIN) },
      ]);
    });

    it('cancelado no SGA: encerra a linha', async () => {
      comBoletoVencido(linha());
      sgaAuth.executeRequestWithAuth.mockResolvedValue(sgaSituacao(3));

      await processor.process(jobDaVarredura());

      expect(marcadoresGravados()).toContainEqual({
        verificacaoEncerradaEm: expect.any(Date),
      });
      expect(mail.sendBoletoRevistoriaPago).not.toHaveBeenCalled();
    });

    it('idade máxima: encerra sem consultar o SGA e conta `expirado`', async () => {
      const antes = await expirados();
      comBoletoVencido(linha({ boletoCriadoEm: new Date(agora - 31 * DIA) }));

      await processor.process(jobDaVarredura());

      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(await expirados()).toBe(antes + 1);
      expect(marcadoresGravados()).toContainEqual({
        verificacaoEncerradaEm: new Date(agora),
      });
    });
  });

  describe('job antigo e varredura não disputam o mesmo boleto', () => {
    it('linha que já está na varredura: o job antigo só se remove, sem consultar o SGA', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue({
        ...pagamento(60 * MIN, 2 * MIN),
        proximaConsultaEm: new Date(agora + MIN),
        verificacaoEncerradaEm: null,
      });

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
    });

    it('linha com a verificação já encerrada: idem', async () => {
      prisma.reinspectionPayment.findUnique.mockResolvedValue({
        ...pagamento(60 * MIN, 2 * MIN, true),
        proximaConsultaEm: null,
        verificacaoEncerradaEm: new Date(agora - MIN),
      });

      await processor.process(job() as Job<never>);

      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('chave-123');
    });

    it('o job antigo grava o contato na linha, mas NÃO a coloca na varredura', async () => {
      await processor.process(job() as Job<never>);

      const { update, create } = prisma.reinspectionPayment.upsert.mock
        .calls[0][0] as {
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      };
      for (const dados of [update, create]) {
        expect(dados).toMatchObject({
          baseOrigin: 'MAIS_PRIME',
          codigoVeiculo: '55',
          codigoAssociado: 9,
          nomeAssociado: 'Fulano de Tal',
          telefoneAssociado: '31999999999',
        });
        expect(dados).not.toHaveProperty('proximaConsultaEm');
      }
    });

    it('idade máxima no job antigo: encerra a linha e conta `expirado`', async () => {
      const antes = await expirados();
      prisma.reinspectionPayment.findUnique.mockResolvedValue(
        pagamento(31 * DIA, 60 * MIN),
      );

      await processor.process(job() as Job<never>);

      expect(await expirados()).toBe(antes + 1);
      expect(marcadoresGravados()).toEqual([
        { verificacaoEncerradaEm: expect.any(Date) },
      ]);
    });

    it('job de nome desconhecido: erro definitivo, sem adivinhar o payload nem tocar o SGA', async () => {
      await expect(
        processor.process({ name: 'outro-job', data: {} } as Job<never>),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('onApplicationBootstrap', () => {
    it('garante UM agendador para a varredura de todos os boletos', async () => {
      await processor.onApplicationBootstrap();

      expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        'boleto-verificacao-varredura',
        { every: 60_000 },
        expect.objectContaining({
          name: 'varrer-boletos',
          opts: expect.objectContaining({ attempts: 1 }),
        }),
      );
    });

    it('repetível no formato do BullMQ instalado (sem `id`): o nosso_numero vem do próximo job agendado', async () => {
      queue.getJobSchedulers.mockResolvedValue([
        { key: 'hash-a', name: 'verificar-boleto', next: 1000 },
        { key: 'hash-b', name: 'verificar-boleto', next: 2000 },
        // Mesmo boleto do `hash-b`, criado com outro `endDate`.
        { key: 'hash-c', name: 'verificar-boleto', next: 2000 },
        undefined,
      ]);
      queue.getJob.mockImplementation((id: string) =>
        Promise.resolve({
          data: { nosso_numero: id.startsWith('repeat:hash-a:') ? 111 : 222 },
        }),
      );
      prisma.reinspectionPayment.findUnique.mockImplementation(
        ({ where }: { where: { nossoNumero: string } }) =>
          Promise.resolve(
            where.nossoNumero === '111'
              ? { boletoCriadoEm: new Date(agora - 40 * DIA) }
              : { boletoCriadoEm: new Date(agora - 1 * DIA) },
          ),
      );

      await processor.onApplicationBootstrap();

      expect(queue.getJob).toHaveBeenCalledWith('repeat:hash-a:1000');
      expect(queue.removeRepeatableByKey.mock.calls).toEqual([
        ['hash-a'],
        ['hash-c'],
      ]);
    });

    it('encerra só os pollers de boletos além da idade máxima', async () => {
      queue.getJobSchedulers.mockResolvedValue([
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
      queue.getJobSchedulers.mockRejectedValue(new Error('redis fora'));
      await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});

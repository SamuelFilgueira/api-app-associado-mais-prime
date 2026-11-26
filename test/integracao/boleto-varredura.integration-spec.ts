import { resetTenantConfigCache } from 'src/config/tenant.config';
import { PrismaService } from 'src/database/prisma.service';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import {
  EVENTO_BOLETO_PAGO,
  PagamentoBoletoRepository,
  PagamentoReservado,
} from 'src/sga/repositories/pagamento-boleto.repository';
import { BoletoVerificacaoVarreduraService } from 'src/sga/services/boleto-verificacao-varredura.service';
import { VerificarPagamentoBoletoService } from 'src/sga/services/verificar-pagamento-boleto.service';
import { TEST_DATABASE_URL, describeComBanco } from './ambiente';

const MARCA = `it-varredura-${process.pid}`;
const MIN = 60_000;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Datas do teste ficam em 2001: o banco é compartilhado entre as suítes, e
 * uma reserva com o relógio de verdade pegaria boletos de outras. Com o
 * "agora" em 2001, só as linhas deste arquivo estão vencidas.
 */
const AGORA = new Date('2001-06-01T12:00:00.000Z');
const antes = (ms: number) => new Date(AGORA.getTime() - ms);

/**
 * Verificação de pagamento por varredura contra o banco real: reserva com
 * `SELECT ... FOR UPDATE SKIP LOCKED`, marcadores condicionais e o evento
 * `boleto.pago` gravado na mesma transação do pagamento.
 */
describeComBanco('Banco real — varredura da verificação de boletos', () => {
  let prisma: PrismaService;
  let pagamentos: PagamentoBoletoRepository;
  let userId: number;
  let userVehicleId: number;
  const basesOriginais = process.env.TENANT_BASES;

  const numero = (n: number | string) => `${MARCA}-${n}`;
  const meus = { nossoNumero: { startsWith: MARCA } };

  const criar = (n: number | string, dados: Record<string, unknown> = {}) =>
    prisma.reinspectionPayment.create({
      data: {
        userVehicleId,
        nossoNumero: numero(n),
        situacaoBoleto: 'CRIADO',
        boletoCriadoEm: antes(60 * MIN),
        proximaConsultaEm: antes(MIN),
        baseOrigin: 'MAIS_PRIME',
        codigoVeiculo: '55',
        ...dados,
      },
    });

  const reservar = (limite = 10) =>
    pagamentos.reservarLote({ agora: AGORA, limite, reservaMs: 10 * MIN });
  const numeros = (linhas: PagamentoReservado[]) =>
    linhas.map((l) => l.nossoNumero).sort();
  const eventos = (n: number | string) =>
    prisma.outboxEvento.findMany({
      where: { tipo: EVENTO_BOLETO_PAGO, chave: numero(n) },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    // O Prisma recarrega o `.env` da máquina ao instanciar o client: as
    // bases do teste são fixadas depois disso.
    process.env.TENANT_BASES = 'MAIS_PRIME:,MAIS_PRIME_RS:_RS';
    resetTenantConfigCache();
    pagamentos = new PagamentoBoletoRepository(
      prisma,
      new OutboxService(prisma, {} as ProdutorDeFilas),
    );

    const usuario = await prisma.user.create({
      data: {
        name: MARCA,
        cpf: `6${String(process.pid).padStart(10, '0')}`.slice(0, 11),
        email: `${MARCA}@teste.local`,
        passwordHash: 'x',
        baseOrigin: 'MAIS_PRIME',
      },
    });
    userId = usuario.id;
    const veiculo = await prisma.userVehicle.create({
      data: { userId, chassi: `CH${process.pid}VARRE`, plate: 'ABC1D23' },
    });
    userVehicleId = veiculo.id;
  });

  afterAll(async () => {
    await prisma.reinspectionPayment.deleteMany({ where: meus });
    await prisma.outboxEvento.deleteMany({
      where: { tipo: EVENTO_BOLETO_PAGO, chave: { startsWith: MARCA } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    if (basesOriginais === undefined) delete process.env.TENANT_BASES;
    else process.env.TENANT_BASES = basesOriginais;
    resetTenantConfigCache();
  });

  beforeEach(async () => {
    await prisma.reinspectionPayment.deleteMany({ where: meus });
    await prisma.outboxEvento.deleteMany({
      where: { tipo: EVENTO_BOLETO_PAGO, chave: { startsWith: MARCA } },
    });
  });

  describe('reserva do lote', () => {
    it('pega só boleto com a consulta vencida e a verificação em aberto', async () => {
      await criar('vencido');
      await criar('futuro', {
        proximaConsultaEm: new Date(AGORA.getTime() + MIN),
      });
      await criar('encerrado', { verificacaoEncerradaEm: antes(MIN) });
      // Boleto antigo: sem `proximaConsultaEm`, segue com o job repetível.
      await criar('antigo', { proximaConsultaEm: null });

      const lote = await reservar();

      expect(numeros(lote)).toEqual([numero('vencido')]);
      expect(lote[0]).toMatchObject({
        userVehicleId,
        baseOrigin: 'MAIS_PRIME',
        codigoVeiculo: '55',
        pago: false,
      });
    });

    it('a reserva empurra `proximaConsultaEm`: a varredura seguinte não pega a mesma linha', async () => {
      await criar(1);
      await criar(2);

      const primeira = await reservar();
      const segunda = await reservar();

      expect(primeira).toHaveLength(2);
      expect(segunda).toHaveLength(0);
      const gravadas = await prisma.reinspectionPayment.findMany({
        where: meus,
      });
      for (const linha of gravadas) {
        expect(linha.proximaConsultaEm).toEqual(
          new Date(AGORA.getTime() + 10 * MIN),
        );
      }
      expect(primeira[0].reservadaAte).toEqual(
        new Date(AGORA.getTime() + 10 * MIN),
      );
    });

    it('duas varreduras simultâneas nunca pegam o mesmo boleto', async () => {
      for (let i = 0; i < 12; i++) await criar(i);

      const lotes = await Promise.all([
        reservar(5),
        reservar(5),
        reservar(5),
        reservar(5),
      ]);

      const todos = lotes.flatMap((lote) => lote.map((l) => l.nossoNumero));
      expect(todos).toHaveLength(12);
      expect(new Set(todos).size).toBe(12);
      for (const lote of lotes) expect(lote.length).toBeLessThanOrEqual(5);
    });

    it('SKIP LOCKED: linha travada por outra transação é pulada, sem esperar a trava', async () => {
      const travada = await criar('travada', {
        proximaConsultaEm: antes(5 * MIN),
      });
      await criar('livre');

      let liberar!: () => void;
      const segurando = new Promise<void>((resolve) => (liberar = resolve));
      let travou!: () => void;
      const travouALinha = new Promise<void>((resolve) => (travou = resolve));
      const outraTransacao = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM ReinspectionPayment WHERE id = ${travada.id} FOR UPDATE`;
        travou();
        await segurando;
      });
      await travouALinha;

      const inicio = Date.now();
      const lote = await reservar();
      const demorou = Date.now() - inicio;
      liberar();
      await outraTransacao;

      // Sem SKIP LOCKED a reserva ficaria parada na linha travada (que é a
      // mais antiga, a primeira da ordenação) até a outra transação terminar.
      expect(numeros(lote)).toEqual([numero('livre')]);
      expect(demorou).toBeLessThan(2_000);
      // A travada continua vencida para a próxima rodada.
      await dormir(20);
      expect(numeros(await reservar())).toEqual([numero('travada')]);
    });

    it('respeita o limite e começa pelas mais atrasadas', async () => {
      await criar('c', { proximaConsultaEm: antes(1 * MIN) });
      await criar('a', { proximaConsultaEm: antes(30 * MIN) });
      await criar('b', { proximaConsultaEm: antes(10 * MIN) });

      expect(numeros(await reservar(2))).toEqual([numero('a'), numero('b')]);
    });
  });

  describe('varredura inteira', () => {
    /** Reserva sempre com o "agora" de 2001 (ver o comentário de `AGORA`). */
    const varreduraDoTeste = (verificados: string[]) => {
      const repositorio = Object.create(
        pagamentos,
      ) as PagamentoBoletoRepository;
      // A seleção usa o "agora" de 2001; a reserva continua valendo 10 min
      // a partir do relógio de verdade, como em produção.
      repositorio.reservarLote = (params) =>
        pagamentos.reservarLote({
          ...params,
          agora: AGORA,
          reservaMs: Date.now() - AGORA.getTime() + params.reservaMs,
        });
      const verificacao = {
        verificar: async (boleto: { nossoNumero: string }) => {
          verificados.push(boleto.nossoNumero);
          await dormir(15);
          return 'EM_ABERTO' as const;
        },
      };
      const servico = new BoletoVerificacaoVarreduraService(
        repositorio,
        verificacao as unknown as VerificarPagamentoBoletoService,
      );
      // Boletos "de 2001" estariam além da idade máxima: o teste é da
      // reserva e do reagendamento, não da expiração.
      Object.assign(servico, {
        config: {
          intervaloBaseMs: 120_000,
          maxDias: 365 * 100,
          intervaloApos24hMin: 10,
          intervaloApos7dMin: 60,
          espacamentoMs: 0,
        },
      });
      return servico;
    };

    it('duas varreduras ao mesmo tempo: cada boleto é verificado UMA vez e reagendado', async () => {
      for (let i = 0; i < 14; i++) await criar(i);
      const verificados: string[] = [];

      const [a, b] = await Promise.all([
        varreduraDoTeste(verificados).executar(),
        varreduraDoTeste(verificados).executar(),
      ]);

      expect(verificados).toHaveLength(14);
      expect(new Set(verificados).size).toBe(14);
      expect(a.reservados + b.reservados).toBe(14);
      // Cada linha saiu da reserva com a próxima consulta de verdade (pela
      // idade do boleto: mais de 7 dias → 60 min a partir de agora).
      const gravadas = await prisma.reinspectionPayment.findMany({
        where: meus,
      });
      for (const linha of gravadas) {
        expect(linha.verificacaoEncerradaEm).toBeNull();
        expect(linha.proximaConsultaEm!.getTime()).toBeGreaterThan(
          Date.now() + 55 * MIN,
        );
      }
    });
  });

  describe('gravação da consulta e outbox', () => {
    const gravar = (n: string, extra: Record<string, unknown> = {}) =>
      pagamentos.gravarConsulta({
        userVehicleId,
        nossoNumero: numero(n),
        situacao: '1',
        pago: true,
        agora: AGORA,
        dados: { baseOrigin: 'MAIS_PRIME', codigoVeiculo: '55' },
        ...extra,
      });

    it('boleto pago: grava `pago = true` e UM evento boleto.pago com a chave do boleto', async () => {
      await criar('pago');

      await gravar('pago');

      expect(
        await prisma.reinspectionPayment.findUnique({
          where: { nossoNumero: numero('pago') },
        }),
      ).toMatchObject({ pago: true, pagoEm: AGORA, situacaoBoleto: '1' });
      const [evento, ...outros] = await eventos('pago');
      expect(outros).toHaveLength(0);
      expect(evento).toMatchObject({
        tipo: 'boleto.pago',
        chave: numero('pago'),
        baseOrigin: 'MAIS_PRIME',
        estado: 'PENDENTE',
        payload: { nossoNumero: numero('pago') },
      });
    });

    it('reentrada (reativação recusada, nova rodada): não cria um segundo evento e mantém a data do pagamento', async () => {
      await criar('reentrada');
      await gravar('reentrada');
      const depois = new Date(AGORA.getTime() + 10 * MIN);

      await Promise.all([
        gravar('reentrada', { agora: depois, pagoEmAnterior: AGORA }),
        gravar('reentrada', { agora: depois, pagoEmAnterior: AGORA }),
      ]);

      expect(await eventos('reentrada')).toHaveLength(1);
      expect(
        (
          await prisma.reinspectionPayment.findUnique({
            where: { nossoNumero: numero('reentrada') },
          })
        )?.pagoEm,
      ).toEqual(AGORA);
    });

    it('boleto em aberto: nenhum evento', async () => {
      await criar('aberto');

      await gravar('aberto', { situacao: '2', pago: false });

      expect(await eventos('aberto')).toHaveLength(0);
    });

    it('evento e pagamento são UMA transação: se o evento não grava, o pagamento também não', async () => {
      await criar('atomico');
      const outboxQuebrado = {
        registrar: () => Promise.reject(new Error('outbox indisponível')),
      };
      const repositorio = new PagamentoBoletoRepository(
        prisma,
        outboxQuebrado as unknown as OutboxService,
      );

      await expect(
        repositorio.gravarConsulta({
          userVehicleId,
          nossoNumero: numero('atomico'),
          situacao: '1',
          pago: true,
          agora: AGORA,
        }),
      ).rejects.toThrow('outbox indisponível');

      expect(
        await prisma.reinspectionPayment.findUnique({
          where: { nossoNumero: numero('atomico') },
        }),
      ).toMatchObject({ pago: false, pagoEm: null, situacaoBoleto: 'CRIADO' });
    });

    it('job antigo sem linha no banco: a consulta cria a linha, fora da varredura', async () => {
      await gravar('sem-linha', { situacao: '2', pago: false });

      expect(
        await prisma.reinspectionPayment.findUnique({
          where: { nossoNumero: numero('sem-linha') },
        }),
      ).toMatchObject({
        userVehicleId,
        pago: false,
        proximaConsultaEm: null,
        codigoVeiculo: '55',
      });
    });
  });

  describe('marcadores e encerramento (escritas condicionais)', () => {
    it('cada marcador é gravado uma única vez', async () => {
      const linha = await criar('marcadores', { pago: true });
      const nn = numero('marcadores');

      expect(await pagamentos.marcarReativado(nn, AGORA)).toBe(true);
      expect(await pagamentos.marcarReativado(nn, new Date())).toBe(false);

      const disputas = await Promise.all(
        Array.from({ length: 6 }, () =>
          pagamentos.reivindicarAvisoPorEmail(linha.id, AGORA),
        ),
      );
      expect(disputas.filter(Boolean)).toHaveLength(1);

      expect(await pagamentos.encerrar(nn, AGORA)).toBe(true);
      expect(await pagamentos.encerrar(nn, new Date())).toBe(false);

      expect(
        await prisma.reinspectionPayment.findUnique({
          where: { id: linha.id },
        }),
      ).toMatchObject({
        reativadoEm: AGORA,
        pagoNotificadoEm: AGORA,
        verificacaoEncerradaEm: AGORA,
      });
      // Encerrada: não volta à varredura nem é reagendada.
      expect(await pagamentos.reagendar(linha.id, antes(MIN))).toBe(false);
      expect(await reservar()).toHaveLength(0);
    });

    it('e-mail que falhou devolve o marcador — mas só o de quem o reivindicou', async () => {
      const linha = await criar('devolucao', { pago: true });
      await pagamentos.reivindicarAvisoPorEmail(linha.id, AGORA);

      await pagamentos.devolverAvisoPorEmail(linha.id, new Date('2001-01-01'));
      expect(
        (
          await prisma.reinspectionPayment.findUnique({
            where: { id: linha.id },
          })
        )?.pagoNotificadoEm,
      ).toEqual(AGORA);

      await pagamentos.devolverAvisoPorEmail(linha.id, AGORA);
      expect(await pagamentos.reivindicarAvisoPorEmail(linha.id, AGORA)).toBe(
        true,
      );
    });
  });

  describe('boleto novo entra na varredura', () => {
    const registrar = (n: string, extra: Record<string, unknown> = {}) =>
      pagamentos.registrarBoleto({
        userVehicleId,
        nossoNumero: numero(n),
        linhaDigitavel: '0001',
        linkBoleto: 'https://sga/boleto',
        agora: antes(MIN),
        verificacao: {
          baseOrigin: 'MAIS_PRIME',
          codigoVeiculo: '55',
          codigoAssociado: 9,
          nomeAssociado: 'Fulano de Tal',
          telefoneAssociado: '31999999999',
        },
        ...extra,
      });

    it('grava o que o job repetível carregava e já fica vencido para a primeira consulta', async () => {
      await registrar('novo');

      const [linha] = await reservar();

      expect(linha).toMatchObject({
        nossoNumero: numero('novo'),
        baseOrigin: 'MAIS_PRIME',
        codigoVeiculo: '55',
        codigoAssociado: 9,
        nomeAssociado: 'Fulano de Tal',
        telefoneAssociado: '31999999999',
        verificacaoEncerradaEm: null,
      });
    });

    it('regravar um boleto já encerrado (nova adoção) reabre a verificação, sem perder o link', async () => {
      await registrar('reaberto');
      await pagamentos.encerrar(numero('reaberto'), AGORA);

      await registrar('reaberto', { linkBoleto: null, linhaDigitavel: null });

      expect(numeros(await reservar())).toEqual([numero('reaberto')]);
      expect(
        await prisma.reinspectionPayment.findUnique({
          where: { nossoNumero: numero('reaberto') },
        }),
      ).toMatchObject({
        linkBoleto: 'https://sga/boleto',
        linhaDigitavel: '0001',
      });
    });

    it('sem os dados da verificação a linha é gravada, mas não entra na varredura', async () => {
      await registrar('sem-verificacao', { verificacao: undefined });

      expect(await reservar()).toHaveLength(0);
    });
  });
});

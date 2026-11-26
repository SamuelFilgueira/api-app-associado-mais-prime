import Redis from 'ioredis';
import { PrismaService } from 'src/database/prisma.service';
import {
  IdempotenciaService,
  hashDoCorpo,
} from 'src/infra/idempotencia/idempotencia.service';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { TravaService } from 'src/infra/redis/trava.service';
import { ProdutorDeFilas } from 'src/queue/produtor-de-filas.service';
import {
  TEST_DATABASE_URL,
  describeComBanco,
  describeComRedis,
  redisDeTeste,
} from './ambiente';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Usuário fictício por execução, para as suítes não se pisarem. */
const USER_ID = 900_000 + (process.pid % 90_000);

describeComBanco('Banco real — idempotência e outbox', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.chaveDeIdempotencia.deleteMany({ where: { userId: USER_ID } });
    await prisma.outboxEvento.deleteMany({
      where: { tipo: { startsWith: `it-${process.pid}` } },
    });
    await prisma.$disconnect();
  });

  describe('IdempotenciaService', () => {
    let servico: IdempotenciaService;
    let execucoes: number;
    const comprar = (
      chave: string | undefined,
      corpo: unknown = { premioId: 1 },
    ) =>
      servico.executar(
        { userId: USER_ID, escopo: 'sorte.loja.comprar', chave, corpo },
        async () => {
          execucoes += 1;
          await dormir(40);
          return { pedido: `PED-${execucoes}`, saldo: 10 - execucoes };
        },
      );

    beforeEach(async () => {
      servico = new IdempotenciaService(prisma);
      execucoes = 0;
      await prisma.chaveDeIdempotencia.deleteMany({
        where: { userId: USER_ID },
      });
    });

    it('repetição com a mesma chave devolve a mesma resposta sem executar de novo', async () => {
      const primeira = await comprar('chave-0001-aaaa');
      const repetida = await comprar('chave-0001-aaaa');

      expect(execucoes).toBe(1);
      expect(repetida).toEqual(primeira);
    });

    it('toque duplo (requisições simultâneas): a operação roda uma única vez', async () => {
      const resultados = await Promise.allSettled(
        Array.from({ length: 6 }, () => comprar('chave-0002-bbbb')),
      );

      expect(execucoes).toBe(1);
      const respostas = resultados
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value);
      expect(respostas.length).toBeGreaterThanOrEqual(1);
      expect(new Set(respostas.map((r) => r.pedido))).toEqual(
        new Set(['PED-1']),
      );
      // As que chegaram no meio recebem 409, nunca um segundo pedido.
      for (const r of resultados) {
        if (r.status === 'rejected') {
          expect((r.reason as { getStatus(): number }).getStatus()).toBe(409);
        }
      }
    });

    it('mesma chave com outro corpo → 422, sem executar', async () => {
      await comprar('chave-0003-cccc', { premioId: 1 });

      await expect(
        comprar('chave-0003-cccc', { premioId: 2 }),
      ).rejects.toMatchObject({
        response: { code: 'IDEMPOTENCIA_CHAVE_REUTILIZADA' },
      });
      expect(execucoes).toBe(1);
    });

    it('a ordem dos campos do corpo não muda a chave', async () => {
      await comprar('chave-0004-dddd', { a: 1, b: 2 });
      await comprar('chave-0004-dddd', { b: 2, a: 1 });

      expect(execucoes).toBe(1);
    });

    it('operação que falha libera a chave: a nova tentativa executa', async () => {
      const falhar = () =>
        servico.executar(
          {
            userId: USER_ID,
            escopo: 'sorte.loja.comprar',
            chave: 'chave-0005-eeee',
            corpo: {},
          },
          () => Promise.reject(new Error('saldo insuficiente')),
        );
      await expect(falhar()).rejects.toThrow('saldo insuficiente');

      const depois = await servico.executar(
        {
          userId: USER_ID,
          escopo: 'sorte.loja.comprar',
          chave: 'chave-0005-eeee',
          corpo: {},
        },
        () => Promise.resolve({ ok: true }),
      );

      expect(depois).toEqual({ ok: true });
    });

    it('sem o header a operação roda sempre (app antigo continua funcionando)', async () => {
      await comprar(undefined);
      await comprar(undefined);

      expect(execucoes).toBe(2);
    });

    it('chave em formato inválido → 400', async () => {
      await expect(comprar('curta')).rejects.toMatchObject({
        response: { code: 'IDEMPOTENCIA_CHAVE_INVALIDA' },
      });
      expect(execucoes).toBe(0);
    });

    it('a chave é por usuário e por operação', async () => {
      await comprar('chave-0006-ffff');
      await servico.executar(
        {
          userId: USER_ID,
          escopo: 'parceiros.cupom.resgatar',
          chave: 'chave-0006-ffff',
          corpo: {},
        },
        () => {
          execucoes += 1;
          return Promise.resolve({ cupom: 'X' });
        },
      );

      expect(execucoes).toBe(2);
    });

    it('operação abandonada (processo morreu no meio) é assumida depois de um minuto', async () => {
      await prisma.chaveDeIdempotencia.create({
        data: {
          userId: USER_ID,
          escopo: 'sorte.loja.comprar',
          chave: 'chave-0007-gggg',
          corpoHash: hashDoCorpo({ premioId: 1 }),
          criadoEm: new Date(Date.now() - 5 * 60_000),
          expiraEm: new Date(Date.now() + 3_600_000),
        },
      });

      const resposta = await comprar('chave-0007-gggg');

      expect(execucoes).toBe(1);
      expect(resposta.pedido).toBe('PED-1');
    });

    it('operação em curso há poucos segundos: a repetição recebe 409 e não executa', async () => {
      await prisma.chaveDeIdempotencia.create({
        data: {
          userId: USER_ID,
          escopo: 'sorte.loja.comprar',
          chave: 'chave-0008-hhhh',
          corpoHash: hashDoCorpo({ premioId: 1 }),
          expiraEm: new Date(Date.now() + 3_600_000),
        },
      });

      await expect(comprar('chave-0008-hhhh')).rejects.toMatchObject({
        response: { code: 'OPERACAO_EM_ANDAMENTO' },
      });
      expect(execucoes).toBe(0);
    });
  });

  describe('OutboxService', () => {
    const tipo = `it-${process.pid}.boleto.pago`;
    let produtor: { enfileirar: jest.Mock };
    let outbox: OutboxService;

    beforeEach(async () => {
      await prisma.outboxEvento.deleteMany({ where: { tipo } });
      produtor = { enfileirar: jest.fn().mockResolvedValue({ id: 'j' }) };
      outbox = new OutboxService(
        prisma,
        produtor as unknown as ProdutorDeFilas,
      );
      outbox.registrarDestino(tipo, { fila: 'manutencao', job: 'reativar' });
    });

    const registrar = (chave: string) =>
      prisma.$transaction((tx) =>
        outbox.registrar(tx, {
          tipo,
          chave,
          base: 'MAIS_PRIME',
          payload: { nossoNumero: chave },
        }),
      );

    it('transação desfeita não deixa evento', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await outbox.registrar(tx, { tipo, chave: 'b-1', payload: {} });
          throw new Error('falhou depois de registrar');
        }),
      ).rejects.toThrow('falhou depois');

      expect(await prisma.outboxEvento.count({ where: { tipo } })).toBe(0);
    });

    it('o vencimento é comparado com o relógio da aplicação, não com o NOW() do banco (fuso do servidor não atrasa o evento)', async () => {
      await registrar('b-fuso');
      const [evento] = await prisma.outboxEvento.findMany({ where: { tipo } });
      const umaHora = 3_600_000;
      // Adiado para daqui a 1 h, como faz o backoff de uma publicação falha.
      await prisma.outboxEvento.update({
        where: { id: evento.id },
        data: { proximaTentativaEm: new Date(Date.now() + umaHora) },
      });

      await outbox.despachar(new Date());
      expect(
        produtor.enfileirar.mock.calls.filter((c) => c[1] === 'reativar'),
      ).toHaveLength(0);

      await outbox.despachar(new Date(Date.now() + 2 * umaHora));
      expect(
        produtor.enfileirar.mock.calls.filter((c) => c[1] === 'reativar'),
      ).toHaveLength(1);
    });

    it('evento confirmado é publicado uma vez, com base e jobId derivados dele', async () => {
      await registrar('b-2');
      const [evento] = await prisma.outboxEvento.findMany({ where: { tipo } });

      await outbox.despachar();
      await outbox.despachar();

      const nossas = produtor.enfileirar.mock.calls.filter(
        (c) => c[1] === 'reativar',
      );
      expect(nossas).toHaveLength(1);
      expect(nossas[0]).toEqual([
        'manutencao',
        'reativar',
        { nossoNumero: 'b-2' },
        { base: 'MAIS_PRIME', jobId: `outbox-${evento.id}` },
      ]);
      expect(
        (
          await prisma.outboxEvento.findUniqueOrThrow({
            where: { id: evento.id },
          })
        ).estado,
      ).toBe('PUBLICADO');
    });

    it('o mesmo fato registrado duas vezes gera um evento só', async () => {
      await registrar('b-3');
      await registrar('b-3');

      expect(await prisma.outboxEvento.count({ where: { tipo } })).toBe(1);
    });

    it('fila fora: o evento fica pendente, com nova tentativa mais adiante', async () => {
      await registrar('b-4');
      produtor.enfileirar.mockRejectedValue(new Error('Redis fora'));

      await outbox.despachar();

      const [evento] = await prisma.outboxEvento.findMany({ where: { tipo } });
      expect(evento).toMatchObject({ estado: 'PENDENTE', tentativas: 1 });
      expect(evento.ultimoErro).toContain('Redis fora');
      expect(evento.proximaTentativaEm.getTime()).toBeGreaterThan(
        Date.now() + 2_000,
      );
    });

    it('dois despachantes ao mesmo tempo: cada evento sai uma única vez (SKIP LOCKED)', async () => {
      for (let i = 0; i < 12; i++) await registrar(`c-${i}`);
      const outro = new OutboxService(
        prisma,
        produtor as unknown as ProdutorDeFilas,
      );
      outro.registrarDestino(tipo, { fila: 'manutencao', job: 'reativar' });
      produtor.enfileirar.mockImplementation(async () => {
        await dormir(15);
        return { id: 'j' };
      });

      await Promise.all([outbox.despachar(), outro.despachar()]);

      const chaves = produtor.enfileirar.mock.calls
        .filter((c) => c[1] === 'reativar')
        .map((c) => (c[2] as { nossoNumero: string }).nossoNumero);
      expect(chaves).toHaveLength(12);
      expect(new Set(chaves).size).toBe(12);
    });
  });
});

describeComRedis('Redis real — trava distribuída', () => {
  let redis: Redis;
  let outroRedis: Redis;

  beforeAll(() => {
    redis = redisDeTeste();
    outroRedis = redisDeTeste();
  });

  afterAll(async () => {
    await redis.quit();
    await outroRedis.quit();
  });

  it('só um processo roda a rotina; o outro é avisado e não espera', async () => {
    const a = new TravaService(redis);
    const b = new TravaService(outroRedis);
    const chave = `it-${process.pid}:regua:MAIS_PRIME:2026-11-25`;
    let execucoes = 0;
    const rotina = async () => {
      execucoes += 1;
      await dormir(150);
      return 'feito';
    };

    const [ra, rb] = await Promise.all([
      a.tentar(chave, 5_000, rotina),
      b.tentar(chave, 5_000, rotina),
    ]);

    expect(execucoes).toBe(1);
    expect([ra.executou, rb.executou].sort()).toEqual([false, true]);
  });

  it('a trava é solta ao terminar, inclusive quando a rotina falha', async () => {
    const trava = new TravaService(redis);
    const chave = `it-${process.pid}:marketing`;

    await expect(
      trava.tentar(chave, 5_000, () => Promise.reject(new Error('falhou'))),
    ).rejects.toThrow('falhou');

    await expect(
      trava.tentar(chave, 5_000, () => Promise.resolve('ok')),
    ).resolves.toEqual({ executou: true, valor: 'ok' });
  });

  it('rotina mais longa que o TTL mantém a trava (renovação)', async () => {
    const a = new TravaService(redis);
    const b = new TravaService(outroRedis);
    const chave = `it-${process.pid}:longa`;

    const longa = a.tentar(chave, 1_200, async () => {
      await dormir(2_600);
      return 'ok';
    });
    await dormir(1_900);
    const durante = await b.tentar(chave, 1_200, () =>
      Promise.resolve('invadiu'),
    );

    expect(durante).toEqual({ executou: false });
    await expect(longa).resolves.toEqual({ executou: true, valor: 'ok' });
  });
});

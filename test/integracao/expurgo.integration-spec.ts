import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetAppConfig } from 'src/config/app.config';
import { PrismaService } from 'src/database/prisma.service';
import { ExpurgoService } from 'src/infra/manutencao/expurgo.service';
import { TEST_DATABASE_URL, describeComBanco } from './ambiente';

const DIA = 86_400_000;
const MARCA = `it-expurgo-${process.pid}`;

describeComBanco('Banco real — expurgo de retenção', () => {
  let prisma: PrismaService;
  let expurgo: ExpurgoService;
  let diretorio: string;
  const envOriginal = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    diretorio = await fs.mkdtemp(join(tmpdir(), 'pdf-expurgo-'));
    process.env.PDF_TMP_DIR = diretorio;
    resetAppConfig();
    prisma = new PrismaService();
    await prisma.$connect();
    expurgo = new ExpurgoService(prisma);
  });

  afterAll(async () => {
    await prisma.appVersionValidationLog.deleteMany({
      where: { reason: MARCA },
    });
    await prisma.outboxEvento.deleteMany({ where: { tipo: MARCA } });
    await prisma.chaveDeIdempotencia.deleteMany({ where: { escopo: MARCA } });
    await prisma.$disconnect();
    await fs.rm(diretorio, { recursive: true, force: true });
    process.env = { ...envOriginal };
    resetAppConfig();
  });

  beforeEach(async () => {
    delete process.env.RETENCAO_VERSAO_LOG_DIAS;
    await prisma.appVersionValidationLog.deleteMany({
      where: { reason: MARCA },
    });
    await prisma.outboxEvento.deleteMany({ where: { tipo: MARCA } });
    await prisma.chaveDeIdempotencia.deleteMany({ where: { escopo: MARCA } });
  });

  const criarLogs = (idadesEmDias: number[]) =>
    prisma.appVersionValidationLog.createMany({
      data: idadesEmDias.map((d) => ({
        platform: 'android',
        blocked: false,
        reason: MARCA,
        createdAt: new Date(Date.now() - d * DIA),
      })),
    });
  const contarLogs = () =>
    prisma.appVersionValidationLog.count({ where: { reason: MARCA } });

  it('tabela de negócio sem env de retenção: nada é apagado', async () => {
    await criarLogs([400, 200, 1]);

    const resultado = await expurgo.executar();

    expect(resultado.AppVersionValidationLog).toBeUndefined();
    expect(await contarLogs()).toBe(3);
  });

  it('com a env definida, apaga só o que passou do prazo', async () => {
    process.env.RETENCAO_VERSAO_LOG_DIAS = '30';
    await criarLogs([400, 31, 29, 1]);

    await expurgo.executar();

    expect(await contarLogs()).toBe(2);
  });

  it('tabelas técnicas: outbox publicado antigo e chave de idempotência vencida saem; o resto fica', async () => {
    await prisma.outboxEvento.createMany({
      data: [
        {
          tipo: MARCA,
          chave: 'antigo',
          payload: {},
          estado: 'PUBLICADO',
          publicadoEm: new Date(Date.now() - 10 * DIA),
        },
        {
          tipo: MARCA,
          chave: 'recente',
          payload: {},
          estado: 'PUBLICADO',
          publicadoEm: new Date(),
        },
        {
          tipo: MARCA,
          chave: 'pendente-antigo',
          payload: {},
          criadoEm: new Date(Date.now() - 30 * DIA),
        },
      ],
    });
    await prisma.chaveDeIdempotencia.createMany({
      data: [
        {
          userId: 1,
          escopo: MARCA,
          chave: 'vencida-0001',
          corpoHash: 'x',
          expiraEm: new Date(Date.now() - DIA),
        },
        {
          userId: 1,
          escopo: MARCA,
          chave: 'valida-00001',
          corpoHash: 'x',
          expiraEm: new Date(Date.now() + DIA),
        },
      ],
    });

    await expurgo.executar();

    const eventos = await prisma.outboxEvento.findMany({
      where: { tipo: MARCA },
    });
    expect(eventos.map((e) => e.chave).sort()).toEqual([
      'pendente-antigo',
      'recente',
    ]);
    const chaves = await prisma.chaveDeIdempotencia.findMany({
      where: { escopo: MARCA },
    });
    expect(chaves.map((c) => c.chave)).toEqual(['valida-00001']);
  });

  it('diretório de troca de PDF: só arquivo de pedido órfão há mais de 15 minutos é removido', async () => {
    const velho = join(diretorio, '11111111-1111-1111-1111-111111111111.html');
    const novo = join(diretorio, '22222222-2222-2222-2222-222222222222.pdf');
    const outro = join(diretorio, 'anotacoes.txt');
    await Promise.all([velho, novo, outro].map((f) => fs.writeFile(f, 'x')));
    const haMeiaHora = new Date(Date.now() - 30 * 60_000);
    await fs.utimes(velho, haMeiaHora, haMeiaHora);
    await fs.utimes(outro, haMeiaHora, haMeiaHora);

    const removidos = await expurgo.limparTrocaDePdf();

    expect(removidos).toBe(1);
    expect((await fs.readdir(diretorio)).sort()).toEqual([
      '22222222-2222-2222-2222-222222222222.pdf',
      'anotacoes.txt',
    ]);
  });

  it('rotina registrada por um módulo roda na mesma rodada e entra no resultado', async () => {
    const agora = new Date();
    const rotina = jest.fn().mockResolvedValue(7);
    expurgo.registrarRotina('TabelaDoModulo', rotina);

    const resultado = await expurgo.executar(agora);

    expect(rotina).toHaveBeenCalledWith(agora);
    expect(resultado.TabelaDoModulo).toBe(7);
  });

  it('rotina de módulo que falha não impede as outras, mas a rodada termina em erro', async () => {
    const boa = jest.fn().mockResolvedValue(3);
    expurgo.registrarRotina('ModuloQueFalha', () =>
      Promise.reject(new Error('tabela travada')),
    );
    expurgo.registrarRotina('ModuloBom', boa);

    await expect(expurgo.executar()).rejects.toThrow(
      /Expurgo incompleto — ModuloQueFalha: tabela travada/,
    );
    expect(boa).toHaveBeenCalledTimes(1);
  });
});

import { PrismaService } from 'src/database/prisma.service';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { TEST_DATABASE_URL, describeComBanco } from './ambiente';

const BASE = `IT_CAMPANHA_${process.pid}`;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Publicação de campanha do Associado da Sorte contra o banco real: dois
 * rascunhos da mesma base publicados ao mesmo tempo não podem ficar os dois
 * no ar.
 */
describeComBanco('Banco real — publicação de campanha do Sorte', () => {
  let prisma: PrismaService;
  let uow: SorteUnidadeTrabalho;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    uow = new SorteUnidadeTrabalho(prisma);
  });

  afterAll(async () => {
    await prisma.sorteCampanha.deleteMany({ where: { baseOrigin: BASE } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.sorteCampanha.deleteMany({ where: { baseOrigin: BASE } });
  });

  const criarRascunho = (nome: string) =>
    prisma.sorteCampanha.create({
      data: {
        baseOrigin: BASE,
        nome,
        inicio: new Date(Date.now() - 3_600_000),
        fim: new Date(Date.now() + 86_400_000),
      },
    });

  /** A seção crítica de `SorteCampanhaService.publicar`. */
  const publicar = (id: number, comTravaDaBase: boolean) =>
    uow.executar(async (tx) => {
      if (comTravaDaBase) await tx.travarCampanhasDaBase(BASE);
      const campanha = await tx.travarCampanha(id);
      // Simula as validações (cronograma, período) entre a trava e a checagem.
      await dormir(60);
      if ((await tx.contarCampanhasPublicadas(BASE, id)) > 0) {
        return 'ja-existe-publicada' as const;
      }
      await tx.atualizarCampanha(campanha!.id, {
        estado: 'PUBLICADA',
        publicadaEm: new Date(),
      });
      return 'publicada' as const;
    });

  it('dois rascunhos publicados juntos: só um fica PUBLICADA', async () => {
    const [a, b] = await Promise.all([criarRascunho('A'), criarRascunho('B')]);

    const resultados = await Promise.all([
      publicar(a.id, true),
      publicar(b.id, true),
    ]);

    expect(resultados.sort()).toEqual(['ja-existe-publicada', 'publicada']);
    expect(
      await prisma.sorteCampanha.count({
        where: { baseOrigin: BASE, estado: 'PUBLICADA' },
      }),
    ).toBe(1);
  });

  it('sem a trava da base a corrida existe (é o defeito que a trava fecha)', async () => {
    const [a, b] = await Promise.all([criarRascunho('A'), criarRascunho('B')]);

    await Promise.all([publicar(a.id, false), publicar(b.id, false)]);

    expect(
      await prisma.sorteCampanha.count({
        where: { baseOrigin: BASE, estado: 'PUBLICADA' },
      }),
    ).toBe(2);
  });

  it('publicações de bases diferentes não esperam uma pela outra', async () => {
    const a = await criarRascunho('A');
    const inicio = Date.now();

    const [resultado] = await Promise.all([
      publicar(a.id, true),
      uow.executar(async (tx) => {
        await tx.travarCampanhasDaBase(`${BASE}_OUTRA`);
        await dormir(300);
      }),
    ]);

    expect(resultado).toBe('publicada');
    expect(Date.now() - inicio).toBeLessThan(1_500);
  });
});

import { PrismaService } from 'src/database/prisma.service';
import { DirectPartnersRepository } from 'src/direct-partners/repositories/direct-partners.repository';
import { TEST_DATABASE_URL, describeComBanco } from './ambiente';

const MARCA = `it-cupom-${process.pid}`;

/**
 * Cupom de uso único contra o banco real: a trava serializa os resgates e o
 * índice único (`chaveUsoUnico`) é a última linha de defesa.
 */
describeComBanco('Banco real — cupom de parceiro de uso único', () => {
  let prisma: PrismaService;
  let repository: DirectPartnersRepository;
  let userId: number;
  let couponId: number;
  let partnerId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    repository = new DirectPartnersRepository(prisma);

    const usuario = await prisma.user.create({
      data: {
        name: MARCA,
        cpf: `9${String(process.pid).padStart(10, '0')}`.slice(0, 11),
        email: `${MARCA}@teste.local`,
        passwordHash: 'x',
        baseOrigin: 'MAIS_PRIME',
      },
    });
    userId = usuario.id;

    const parceiro = await prisma.directPartner.create({
      data: {
        name: MARCA,
        shortDescription: 'teste',
        category: 'OUTROS' as never,
        street: 'Rua A',
        district: 'Centro',
        city: 'Rio de Janeiro',
        state: 'RJ' as never,
        zipCode: '20000-000',
        latitude: -22.9,
        longitude: -43.2,
        coupons: {
          create: {
            code: 'TESTE10',
            highlight: '10%',
            title: 'Cupom de teste',
            description: 'teste',
            conditions: [],
            validUntil: new Date(Date.now() + 86_400_000),
            singleUse: true,
          },
        },
      },
      include: { coupons: true },
    });
    partnerId = parceiro.id;
    couponId = parceiro.coupons[0].id;
  });

  afterAll(async () => {
    await prisma.directPartner
      .delete({ where: { id: partnerId } })
      .catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.directPartnerCouponRedemption.deleteMany({
      where: { couponId },
    });
  });

  it('dez resgates simultâneos do mesmo associado criam UM resgate', async () => {
    const resultados = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.resgatarUsoUnico({
          couponId,
          userId,
          baseOrigin: 'MAIS_PRIME',
        }),
      ),
    );

    expect(resultados.filter((r) => r.criado)).toHaveLength(1);
    expect(
      await prisma.directPartnerCouponRedemption.count({
        where: { couponId, userId },
      }),
    ).toBe(1);
    // Todas as respostas apontam para o mesmo resgate.
    expect(new Set(resultados.map((r) => r.redeemedAt.getTime())).size).toBe(1);
  });

  it('o banco recusa um segundo resgate do mesmo par cupom+associado', async () => {
    await repository.resgatarUsoUnico({
      couponId,
      userId,
      baseOrigin: 'MAIS_PRIME',
    });

    await expect(
      prisma.directPartnerCouponRedemption.create({
        data: {
          couponId,
          userId,
          baseOrigin: 'MAIS_PRIME',
          chaveUsoUnico: `${couponId}:${userId}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cupom reutilizável (sem a chave) continua aceitando vários registros', async () => {
    await repository.registrarUso({
      couponId,
      userId,
      baseOrigin: 'MAIS_PRIME',
    });
    await repository.registrarUso({
      couponId,
      userId,
      baseOrigin: 'MAIS_PRIME',
    });

    expect(
      await prisma.directPartnerCouponRedemption.count({
        where: { couponId, userId },
      }),
    ).toBe(2);
  });
});

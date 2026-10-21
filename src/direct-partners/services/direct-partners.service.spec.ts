import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { resetTenantConfigCache } from 'src/config/tenant.config';
import { DirectPartnersRepository } from 'src/direct-partners/repositories/direct-partners.repository';
import { DirectPartnersService } from 'src/direct-partners/services/direct-partners.service';
import { FileUploadService } from 'src/infra/storage/file-upload.service';

describe('DirectPartnersService', () => {
  let service: DirectPartnersService;

  const repository = {
    listarPainel: jest.fn(),
    buscarPainelPorId: jest.fn(),
    criar: jest.fn(),
    atualizar: jest.fn(),
    excluirSoft: jest.fn(),
    excluirDefinitivo: jest.fn(),
    atualizarLogo: jest.fn(),
    reordenar: jest.fn(),
    listarCupons: jest.fn(),
    buscarCupom: jest.fn(),
    criarCupom: jest.fn(),
    atualizarCupom: jest.fn(),
    excluirCupom: jest.fn(),
    listarResgatesDoAssociado: jest.fn(),
    listarApp: jest.fn(),
    buscarAppPorId: jest.fn(),
  };
  const fileUpload = {
    uploadDirectPartnerLogo: jest.fn(),
    deleteDirectPartnerLogo: jest.fn(),
  };
  const alloyalCache = { obterPorBase: jest.fn() };

  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const ontem = new Date();
  ontem.setDate(ontem.getDate() - 1);

  const cupom = (extra: Partial<Record<string, unknown>> = {}) => ({
    id: 7,
    partnerId: 42,
    code: 'PRIME15REV',
    highlight: '15%',
    title: 'Revisão',
    description: 'desc',
    conditions: ['Seg a sex'],
    validFrom: null,
    validUntil: amanha,
    singleUse: false,
    isActive: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { redemptions: 3 },
    ...extra,
  });

  const parceiro = (extra: Partial<Record<string, unknown>> = {}) => ({
    id: 42,
    name: 'Auto Center Premium',
    shortDescription: 'Oficina',
    description: null,
    category: 'AUTOMOTIVO',
    categoryLabel: null,
    alloyalCategoryIds: { MAIS_PRIME: [12, 48] },
    tone: 'ACCENT',
    logoUrl: null,
    coverUrl: null,
    street: 'Av. X',
    number: null,
    complement: 'Quiosque 3',
    district: 'Boa Viagem',
    city: 'Recife',
    state: 'PE',
    zipCode: '51021-020',
    reference: null,
    latitude: -8.1189,
    longitude: -34.8993,
    phone: null,
    whatsapp: null,
    website: null,
    instagram: null,
    openingHoursText: null,
    openingHours: null,
    isActive: true,
    featured: false,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    bases: [{ partnerId: 42, baseOrigin: 'MAIS_PRIME' }],
    coupons: [cupom()],
    ...extra,
  });

  beforeAll(() => {
    delete process.env.TENANT_BASES;
    resetTenantConfigCache();
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectPartnersService,
        { provide: DirectPartnersRepository, useValue: repository },
        { provide: FileUploadService, useValue: fileUpload },
        { provide: AlloyalCategoriesCacheService, useValue: alloyalCache },
      ],
    }).compile();

    service = module.get(DirectPartnersService);
    jest.clearAllMocks();
  });

  describe('opcoes', () => {
    it('lista bases do deploy com rótulo e categorias Alloyal por base', async () => {
      alloyalCache.obterPorBase.mockResolvedValue({
        MAIS_PRIME: [{ id: 12, title: 'Automotivo' }],
        MAIS_PRIME_RS: [],
      });

      const r = await service.opcoes();

      expect(r.bases).toEqual([
        { value: 'MAIS_PRIME', label: 'Mais Prime' },
        { value: 'MAIS_PRIME_RS', label: 'Mais Prime RS' },
      ]);
      expect(r.categorias).toContainEqual({ value: 'SAUDE', label: 'Saúde' });
      expect(r.tons).toHaveLength(5);
      expect(r.ufs).toContain('PE');
      expect(r.categoriasAlloyal.MAIS_PRIME_RS).toEqual([]);
    });
  });

  describe('criar / atualizar', () => {
    const dtoBase = {
      baseOrigins: ['MAIS_PRIME'],
      name: 'Auto Center Premium',
      shortDescription: 'Oficina',
      category: 'AUTOMOTIVO' as const,
      address: {
        street: 'Av. X',
        district: 'Boa Viagem',
        city: 'Recife',
        state: 'PE' as const,
        zipCode: '51021020',
        latitude: -8.1189,
        longitude: -34.8993,
      },
    };

    it('422 BASE_INVALIDA para base desconhecida', async () => {
      await expect(
        service.criar({ ...dtoBase, baseOrigins: ['HERTZ'] }),
      ).rejects.toMatchObject({ response: { code: 'BASE_INVALIDA' } });
      expect(repository.criar).not.toHaveBeenCalled();
    });

    it('422 HORARIO_INVALIDO para dia duplicado', async () => {
      await expect(
        service.criar({
          ...dtoBase,
          openingHours: [
            { weekday: 1, opens: '08:00', closes: '12:00' },
            { weekday: 1, opens: '14:00', closes: '18:00' },
          ],
        }),
      ).rejects.toMatchObject({ response: { code: 'HORARIO_INVALIDO' } });
    });

    it('422 PERIODO_INVALIDO quando validUntil < validFrom no cupom', async () => {
      await expect(
        service.criar({
          ...dtoBase,
          coupons: [
            {
              code: 'PRIME15',
              highlight: '15%',
              title: 't',
              description: 'd',
              conditions: ['c'],
              validFrom: '2026-12-31',
              validUntil: '2026-01-01',
            },
          ],
        }),
      ).rejects.toMatchObject({ response: { code: 'PERIODO_INVALIDO' } });
    });

    it('409 CODIGO_DUPLICADO quando o corpo repete o código', async () => {
      const c = {
        code: 'PRIME15',
        highlight: '15%',
        title: 't',
        description: 'd',
        conditions: ['c'],
        validUntil: '2026-12-31',
      };
      await expect(
        service.criar({ ...dtoBase, coupons: [c, { ...c, title: 'outro' }] }),
      ).rejects.toMatchObject({ response: { code: 'CODIGO_DUPLICADO' } });
    });

    it('normaliza CEP, endereço sem número e cupom em caixa alta', async () => {
      repository.criar.mockResolvedValue(parceiro());

      await service.criar({
        ...dtoBase,
        alloyalCategoryIds: { MAIS_PRIME: [12, 12, 48] },
        coupons: [
          {
            code: 'prime15',
            highlight: '15%',
            title: 't',
            description: 'd',
            conditions: ['c'],
            validUntil: '2026-12-31',
            singleUse: true,
          },
        ],
      });

      const arg = repository.criar.mock.calls[0][0];
      expect(arg.baseOrigins).toEqual(['MAIS_PRIME']);
      expect(arg.data.zipCode).toBe('51021-020');
      expect(arg.data.number).toBeNull();
      expect(arg.data.alloyalCategoryIds).toEqual({ MAIS_PRIME: [12, 48] });
      expect(arg.coupons[0].code).toBe('PRIME15');
      expect(arg.coupons[0].singleUse).toBe(true);
      expect(arg.coupons[0].validUntil.getFullYear()).toBe(2026);
    });

    it('atualizar substitui bases e contato por inteiro', async () => {
      repository.buscarPainelPorId.mockResolvedValue(parceiro());
      repository.atualizar.mockResolvedValue(parceiro());

      await service.atualizar(42, {
        baseOrigins: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
        contact: { phone: '(81) 3465-1200' },
      });

      const arg = repository.atualizar.mock.calls[0][0];
      expect(arg.baseOrigins).toEqual(['MAIS_PRIME', 'MAIS_PRIME_RS']);
      expect(arg.data).toMatchObject({
        phone: '(81) 3465-1200',
        whatsapp: null,
        website: null,
        instagram: null,
      });
      expect(arg.data.name).toBeUndefined();
    });

    it('404 ao atualizar parceiro inexistente', async () => {
      repository.buscarPainelPorId.mockResolvedValue(null);
      await expect(service.atualizar(1, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('detalharPainel', () => {
    it('deriva iniciais, rótulo, status dos cupons e visibleInApp', async () => {
      repository.buscarPainelPorId.mockResolvedValue(
        parceiro({
          coupons: [
            cupom(),
            cupom({ id: 8, code: 'VENCIDO', validUntil: ontem }),
            cupom({ id: 9, code: 'OFF', isActive: false }),
          ],
        }),
      );

      const r = await service.detalharPainel(42);

      expect(r.initials).toBe('AC');
      expect(r.categoryLabel).toBe('Automotivo');
      expect(r.baseOrigins).toEqual(['MAIS_PRIME']);
      expect(r.visibleInApp).toBe(true);
      expect(r.couponsCount).toEqual({ total: 3, visible: 1 });
      expect(r.redemptionsCount).toBe(9);
      expect(r.coupons?.map((c) => c.status)).toEqual([
        'VISIVEL',
        'VENCIDO',
        'INATIVO',
      ]);
      expect(r.coupons?.[0].validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('visibleInApp=false sem cupom visível', async () => {
      repository.buscarPainelPorId.mockResolvedValue(
        parceiro({ coupons: [cupom({ validUntil: ontem })] }),
      );
      const r = await service.detalharPainel(42);
      expect(r.visibleInApp).toBe(false);
    });
  });

  describe('excluir', () => {
    it('soft delete por padrão', async () => {
      repository.buscarPainelPorId.mockResolvedValue(parceiro());
      await service.excluir(42, false, false);
      expect(repository.excluirSoft).toHaveBeenCalledWith(42);
      expect(repository.excluirDefinitivo).not.toHaveBeenCalled();
    });

    it('hard exige perfil ADMIN do painel', async () => {
      repository.buscarPainelPorId.mockResolvedValue(parceiro());
      await expect(service.excluir(42, true, false)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repository.excluirDefinitivo).not.toHaveBeenCalled();
    });

    it('hard remove e apaga a logo do disco', async () => {
      repository.buscarPainelPorId.mockResolvedValue(
        parceiro({ logoUrl: '/uploads/direct-partners/42-1.webp' }),
      );
      await service.excluir(42, true, true);
      expect(repository.excluirDefinitivo).toHaveBeenCalledWith(42);
      expect(fileUpload.deleteDirectPartnerLogo).toHaveBeenCalledWith(
        '/uploads/direct-partners/42-1.webp',
      );
    });
  });

  describe('listarApp', () => {
    const p = (id: number, extra: Partial<Record<string, unknown>> = {}) =>
      parceiro({ id, name: `P${id}`, ...extra });

    it('ordena por destaque, sortOrder, distância e nome', async () => {
      repository.listarApp.mockResolvedValue([
        p(1, { sortOrder: 1, latitude: -8.2, longitude: -34.9 }),
        p(2, { sortOrder: 1, latitude: -8.12, longitude: -34.9 }),
        p(3, { featured: true, sortOrder: 5 }),
        p(4, { sortOrder: 0 }),
      ]);

      const r = await service.listarApp('MAIS_PRIME', {
        lat: -8.1189,
        lng: -34.8993,
        limit: 50,
      });

      expect(r.data.map((i) => i.id)).toEqual([3, 4, 2, 1]);
      expect(r.meta).toEqual({ total: 4, comLocalizacao: true });
      expect(r.data[0].distanciaKm).not.toBeNull();
      expect(r.data[0].melhorBeneficio).toBe('até 15%');
      expect(r.data[0].totalCupons).toBe(1);
      expect(r.data[0].endereco.logradouro).toBe('Av. X – Quiosque 3');
    });

    it('sem coordenadas distanciaKm é null e abertoAgora null sem grade', async () => {
      repository.listarApp.mockResolvedValue([p(1)]);
      const r = await service.listarApp('MAIS_PRIME', { limit: 50 });
      expect(r.data[0].distanciaKm).toBeNull();
      expect(r.data[0].abertoAgora).toBeNull();
      expect(r.meta.comLocalizacao).toBe(false);
    });

    it('400 quando lat vem sem lng', async () => {
      await expect(
        service.listarApp('MAIS_PRIME', { lat: -8.1, limit: 50 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('alloyalCategoryId filtra pela base do JWT com fallback por categoria', async () => {
      repository.listarApp.mockResolvedValue([
        p(1, { alloyalCategoryIds: { MAIS_PRIME: [12] }, category: 'LAZER' }),
        p(2, {
          alloyalCategoryIds: { MAIS_PRIME_RS: [12] },
          category: 'LAZER',
        }),
        p(3, { alloyalCategoryIds: null, category: 'AUTOMOTIVO' }),
      ]);

      const r = await service.listarApp('MAIS_PRIME', {
        alloyalCategoryId: 12,
        categoria: 'AUTOMOTIVO',
        limit: 50,
      });

      expect(r.data.map((i) => i.id).sort()).toEqual([1, 3]);
      // Com alloyalCategoryId a categoria não vai ao banco (é fallback)
      const where = repository.listarApp.mock.calls[0][0].where;
      expect(where.category).toBeUndefined();
    });

    it('repassa a base do JWT e o filtro de destaque ao repositório', async () => {
      repository.listarApp.mockResolvedValue([]);
      await service.listarApp('MAIS_PRIME_RS', { destaque: 'true', limit: 10 });
      expect(repository.listarApp).toHaveBeenCalledWith(
        expect.objectContaining({
          baseOrigin: 'MAIS_PRIME_RS',
          where: expect.objectContaining({ featured: true }),
        }),
      );
    });
  });

  describe('detalharApp', () => {
    it('404 quando não visível na base', async () => {
      repository.buscarAppPorId.mockResolvedValue(null);
      await expect(
        service.detalharApp({ id: 42, baseOrigin: 'MAIS_PRIME', userId: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('uso único esconde o código até o resgate; reutilizável sempre mostra', async () => {
      const quando = new Date('2026-10-18T19:42:03.000Z');
      repository.buscarAppPorId.mockResolvedValue(
        parceiro({
          coupons: [
            cupom({ id: 7, singleUse: false }),
            cupom({ id: 8, code: 'UNICO1', singleUse: true }),
            cupom({ id: 9, code: 'UNICO2', singleUse: true }),
          ],
        }),
      );
      repository.listarResgatesDoAssociado.mockResolvedValue([
        { couponId: 9, redeemedAt: quando },
        { couponId: 9, redeemedAt: new Date('2026-01-01T00:00:00.000Z') },
      ]);

      const r = await service.detalharApp({
        id: 42,
        baseOrigin: 'MAIS_PRIME',
        userId: 1203,
      });

      expect(repository.listarResgatesDoAssociado).toHaveBeenCalledWith(
        [7, 8, 9],
        1203,
      );
      expect(r.cupons[0]).toMatchObject({
        codigo: 'PRIME15REV',
        usoUnico: false,
        resgate: { resgatado: false, resgatadoEm: null },
      });
      expect(r.cupons[1]).toMatchObject({
        codigo: null,
        usoUnico: true,
        resgate: { resgatado: false, resgatadoEm: null },
      });
      expect(r.cupons[2]).toMatchObject({
        codigo: 'UNICO2',
        usoUnico: true,
        resgate: { resgatado: true, resgatadoEm: quando },
      });
      expect(r.contato).toEqual({
        telefone: null,
        whatsapp: null,
        site: null,
        instagram: null,
      });
    });
  });

  describe('cupons', () => {
    it('atualizarCupom valida o período mesclando com o cupom atual', async () => {
      repository.buscarPainelPorId.mockResolvedValue(parceiro());
      repository.buscarCupom.mockResolvedValue(
        cupom({ validFrom: new Date(2026, 11, 1) }),
      );

      await expect(
        service.atualizarCupom(42, 7, { validUntil: '2026-11-30' }),
      ).rejects.toMatchObject({ response: { code: 'PERIODO_INVALIDO' } });
      expect(repository.atualizarCupom).not.toHaveBeenCalled();
    });

    it('traduz violação de unique em 409 CODIGO_DUPLICADO', async () => {
      repository.buscarPainelPorId.mockResolvedValue(parceiro());
      const { Prisma } = jest.requireActual('@prisma/client');
      repository.criarCupom.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.criarCupom(42, {
          code: 'PRIME15REV',
          highlight: '15%',
          title: 't',
          description: 'd',
          conditions: ['c'],
          validUntil: '2026-12-31',
        }),
      ).rejects.toMatchObject({ response: { code: 'CODIGO_DUPLICADO' } });
    });
  });

  describe('logo', () => {
    it('400 sem arquivo', async () => {
      await expect(service.salvarLogo(42)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('grava a nova logo e apaga a anterior', async () => {
      repository.buscarPainelPorId.mockResolvedValue(
        parceiro({ logoUrl: '/uploads/direct-partners/42-old.webp' }),
      );
      fileUpload.uploadDirectPartnerLogo.mockResolvedValue(
        '/uploads/direct-partners/42-new.webp',
      );

      const r = await service.salvarLogo(42, {
        buffer: Buffer.from(''),
      } as Express.Multer.File);

      expect(r).toEqual({ logoUrl: '/uploads/direct-partners/42-new.webp' });
      expect(repository.atualizarLogo).toHaveBeenCalledWith(
        42,
        '/uploads/direct-partners/42-new.webp',
      );
      expect(fileUpload.deleteDirectPartnerLogo).toHaveBeenCalledWith(
        '/uploads/direct-partners/42-old.webp',
      );
    });
  });
});

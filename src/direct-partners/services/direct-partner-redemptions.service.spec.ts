import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DirectPartnersRepository } from 'src/direct-partners/repositories/direct-partners.repository';
import { DirectPartnerRedemptionsService } from 'src/direct-partners/services/direct-partner-redemptions.service';

describe('DirectPartnerRedemptionsService', () => {
  let service: DirectPartnerRedemptionsService;

  const repository = {
    buscarAppPorId: jest.fn(),
    registrarUso: jest.fn(),
    resgatarUsoUnico: jest.fn(),
    buscarCupom: jest.fn(),
    listarResgates: jest.fn(),
  };

  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);

  const cupomReutilizavel = {
    id: 7,
    code: 'PRIME15REV',
    singleUse: false,
    isActive: true,
    validFrom: null,
    validUntil: amanha,
  };
  const cupomUsoUnico = {
    ...cupomReutilizavel,
    id: 8,
    code: 'PRIMEALINHA',
    singleUse: true,
  };

  const parceiro = { id: 42, coupons: [cupomReutilizavel, cupomUsoUnico] };

  const chamada = (couponId: number) => ({
    partnerId: 42,
    couponId,
    userId: 1203,
    baseOrigin: 'MAIS_PRIME',
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectPartnerRedemptionsService,
        { provide: DirectPartnersRepository, useValue: repository },
      ],
    }).compile();

    service = module.get(DirectPartnerRedemptionsService);
    jest.clearAllMocks();
    repository.buscarAppPorId.mockResolvedValue(parceiro);
  });

  it('cupom reutilizável: devolve o código e grava um uso a cada chamada', async () => {
    const quando = new Date('2026-10-18T19:42:03.000Z');
    repository.registrarUso.mockResolvedValue({ redeemedAt: quando });

    const r1 = await service.resgatar(chamada(7));
    const r2 = await service.resgatar(chamada(7));

    expect(r1).toEqual({
      codigo: 'PRIME15REV',
      usoUnico: false,
      resgatadoEm: quando,
    });
    expect(r2.codigo).toBe('PRIME15REV');
    expect(repository.registrarUso).toHaveBeenCalledTimes(2);
    expect(repository.registrarUso).toHaveBeenCalledWith({
      couponId: 7,
      userId: 1203,
      baseOrigin: 'MAIS_PRIME',
    });
    expect(repository.resgatarUsoUnico).not.toHaveBeenCalled();
  });

  it('uso único: primeira vez cria e devolve o código', async () => {
    const quando = new Date('2026-10-18T19:42:03.000Z');
    repository.resgatarUsoUnico.mockResolvedValue({
      criado: true,
      redeemedAt: quando,
    });

    const r = await service.resgatar(chamada(8));

    expect(r).toEqual({
      codigo: 'PRIMEALINHA',
      usoUnico: true,
      resgatadoEm: quando,
    });
    expect(repository.registrarUso).not.toHaveBeenCalled();
  });

  it('uso único: segunda vez devolve 409 CUPOM_JA_UTILIZADO com a data', async () => {
    const quando = new Date('2026-10-18T19:42:03.000Z');
    repository.resgatarUsoUnico.mockResolvedValue({
      criado: false,
      redeemedAt: quando,
    });

    await expect(service.resgatar(chamada(8))).rejects.toMatchObject({
      response: { code: 'CUPOM_JA_UTILIZADO', resgatadoEm: quando },
    });
    await expect(service.resgatar(chamada(8))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('uso único concorrente: o repositório serializa e só um resgate é criado', async () => {
    // Simula a trava do banco: a 1ª chamada cria, a 2ª encontra o registro.
    let criado = false;
    const quando = new Date();
    repository.resgatarUsoUnico.mockImplementation(() => {
      if (!criado) {
        criado = true;
        return Promise.resolve({ criado: true, redeemedAt: quando });
      }
      return Promise.resolve({ criado: false, redeemedAt: quando });
    });

    const resultados = await Promise.allSettled([
      service.resgatar(chamada(8)),
      service.resgatar(chamada(8)),
    ]);

    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const conflito = resultados.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
    );
    expect(ok).toHaveLength(1);
    expect(conflito).toHaveLength(1);
  });

  it('404 quando o parceiro não está visível na base do JWT', async () => {
    repository.buscarAppPorId.mockResolvedValue(null);

    await expect(service.resgatar(chamada(7))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.buscarAppPorId).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, baseOrigin: 'MAIS_PRIME' }),
    );
  });

  it('404 quando o cupom não pertence ao parceiro ou não está visível', async () => {
    await expect(service.resgatar(chamada(999))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    repository.buscarAppPorId.mockResolvedValue({
      id: 42,
      coupons: [{ ...cupomReutilizavel, validUntil: ontem }],
    });
    await expect(service.resgatar(chamada(7))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.registrarUso).not.toHaveBeenCalled();
  });

  it('lista resgates do painel com nome abreviado e CPF mascarado', async () => {
    repository.buscarCupom.mockResolvedValue({ id: 7 });
    repository.listarResgates.mockResolvedValue({
      total: 31,
      data: [
        {
          id: 910,
          redeemedAt: new Date('2026-10-18T19:42:03.000Z'),
          baseOrigin: 'MAIS_PRIME',
          user: { id: 1203, name: 'Maria Silva Souza', cpf: '12345678909' },
        },
      ],
    });

    const r = await service.listarResgates(42, 7, {
      page: 2,
      limit: 20,
      baseOrigin: 'MAIS_PRIME',
    });

    expect(repository.listarResgates).toHaveBeenCalledWith({
      couponId: 7,
      baseOrigin: 'MAIS_PRIME',
      skip: 20,
      take: 20,
    });
    expect(r.meta).toEqual({ page: 2, limit: 20, total: 31, totalPages: 2 });
    expect(r.data[0].associado).toEqual({
      id: 1203,
      nome: 'Maria S.',
      cpfMascarado: '***.456.789-**',
    });
  });
});

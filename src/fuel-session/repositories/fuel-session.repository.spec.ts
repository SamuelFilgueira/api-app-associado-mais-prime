import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/prisma.service';
import { FuelSessionRepository } from 'src/fuel-session/repositories/fuel-session.repository';

const violacaoDeUnico = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'teste',
  });

/**
 * As condições de escrita, com o Prisma trocado por dublê. O índice único e a
 * concorrência de verdade estão em
 * `test/integracao/combustivel-sessao.integration-spec.ts`.
 */
describe('FuelSessionRepository', () => {
  const tx = {
    fuelSession: { updateMany: jest.fn() },
    user: { update: jest.fn() },
  };
  const prisma = {
    fuelSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  let repository: FuelSessionRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.fuelSession.updateMany.mockResolvedValue({ count: 1 });
    tx.fuelSession.updateMany.mockResolvedValue({ count: 1 });
    tx.user.update.mockResolvedValue({});
    repository = new FuelSessionRepository(prisma as unknown as PrismaService);
  });

  describe('criarPendente', () => {
    it('cria a sessão PENDING com a chave de pendência do usuário', async () => {
      const sessao = { id: 's1', status: 'PENDING' };
      prisma.fuelSession.create.mockResolvedValue(sessao);

      await expect(repository.criarPendente(42, 87.5)).resolves.toEqual({
        sessao,
        criada: true,
      });
      expect(prisma.fuelSession.create).toHaveBeenCalledWith({
        data: {
          userId: 42,
          valorAntes: 87.5,
          status: 'PENDING',
          pendenteChave: '42',
        },
      });
    });

    it('índice único recusou (P2002): devolve a sessão pendente que já existe', async () => {
      const existente = { id: 'do-outro-toque', status: 'PENDING' };
      prisma.fuelSession.create.mockRejectedValue(violacaoDeUnico());
      prisma.fuelSession.findUnique.mockResolvedValue(existente);

      await expect(repository.criarPendente(42, 87.5)).resolves.toEqual({
        sessao: existente,
        criada: false,
      });
      expect(prisma.fuelSession.findUnique).toHaveBeenCalledWith({
        where: { pendenteChave: '42' },
      });
      expect(prisma.fuelSession.create).toHaveBeenCalledTimes(1);
    });

    it('a pendente foi encerrada entre a recusa e a leitura: tenta criar de novo', async () => {
      const nova = { id: 's2', status: 'PENDING' };
      prisma.fuelSession.create
        .mockRejectedValueOnce(violacaoDeUnico())
        .mockResolvedValueOnce(nova);
      prisma.fuelSession.findUnique.mockResolvedValue(null);

      await expect(repository.criarPendente(42, 87.5)).resolves.toEqual({
        sessao: nova,
        criada: true,
      });
    });

    it('chave presa em sessão que já saiu de PENDING: solta a chave (só se continuar fora de PENDING) e cria', async () => {
      const nova = { id: 's2', status: 'PENDING' };
      prisma.fuelSession.create
        .mockRejectedValueOnce(violacaoDeUnico())
        .mockResolvedValueOnce(nova);
      prisma.fuelSession.findUnique.mockResolvedValue({
        id: 'antiga',
        status: 'EXPIRED',
      });

      await expect(repository.criarPendente(42, 87.5)).resolves.toEqual({
        sessao: nova,
        criada: true,
      });
      expect(prisma.fuelSession.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'antiga',
          status: { not: 'PENDING' },
          pendenteChave: '42',
        },
        data: { pendenteChave: null },
      });
    });

    it('erro que não é violação de único propaga na hora', async () => {
      const falha = new Error("Can't reach database server");
      prisma.fuelSession.create.mockRejectedValue(falha);

      await expect(repository.criarPendente(42, 87.5)).rejects.toBe(falha);
      expect(prisma.fuelSession.findUnique).not.toHaveBeenCalled();
    });

    it('recusa que não se resolve em três voltas: devolve o erro do banco, não fica em laço', async () => {
      const recusa = violacaoDeUnico();
      prisma.fuelSession.create.mockRejectedValue(recusa);
      prisma.fuelSession.findUnique.mockResolvedValue(null);

      await expect(repository.criarPendente(42, 87.5)).rejects.toBe(recusa);
      expect(prisma.fuelSession.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('concluir', () => {
    const dados = {
      sessionId: 's1',
      userId: 42,
      valorDepois: 112.5,
      diferenca: 12.5,
    };

    it('só conclui se ainda estiver PENDING, anula a chave e grava o total do usuário na mesma transação', async () => {
      await expect(repository.concluir(dados)).resolves.toBe(true);

      expect(tx.fuelSession.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: 'PENDING' },
        data: {
          valorDepois: 112.5,
          diferenca: 12.5,
          status: 'COMPLETED',
          pendenteChave: null,
        },
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 42 },
        data: { totalEconomizado: 112.5 },
      });
    });

    it('nenhuma linha afetada (outra execução ganhou): devolve false e NÃO toca no usuário', async () => {
      tx.fuelSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.concluir(dados)).resolves.toBe(false);
      expect(tx.user.update).not.toHaveBeenCalled();
    });
  });

  describe('expirar', () => {
    it('só expira se ainda estiver PENDING, anulando a chave', async () => {
      await expect(repository.expirar('s1')).resolves.toBe(true);

      expect(prisma.fuelSession.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: 'PENDING' },
        data: { status: 'EXPIRED', pendenteChave: null },
      });
    });

    it('nenhuma linha afetada: devolve false', async () => {
      prisma.fuelSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.expirar('s1')).resolves.toBe(false);
    });
  });

  it('expirarPendentesVencidas: só as PENDING do usuário criadas antes do corte', async () => {
    const corte = new Date('2026-11-25T11:30:00.000Z');
    prisma.fuelSession.updateMany.mockResolvedValue({ count: 2 });

    await expect(repository.expirarPendentesVencidas(42, corte)).resolves.toBe(
      2,
    );
    expect(prisma.fuelSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 42, status: 'PENDING', createdAt: { lt: corte } },
      data: { status: 'EXPIRED', pendenteChave: null },
    });
  });
});

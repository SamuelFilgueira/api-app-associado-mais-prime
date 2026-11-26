import { PrismaService } from 'src/database/prisma.service';
import { BoletoReativacaoRepository } from 'src/sga/repositories/boleto-reativacao.repository';
import { BoletoRetryVarreduraService } from 'src/sga/services/boleto-retry-varredura.service';
import { GerarBoletoReativacaoService } from 'src/sga/services/gerar-boleto-reativacao.service';

/**
 * Varredura do retry: substitui a cadeia de jobs atrasados por revistoria.
 * O que falta tentar vem do banco (`PENDENTE_RETRY` com a tentativa vencida).
 */
describe('BoletoRetryVarreduraService', () => {
  let prisma: { reinspection: { findMany: jest.Mock } };
  let gerar: { processar: jest.Mock };
  let servico: BoletoRetryVarreduraService;
  const agora = new Date('2026-11-26T12:00:00Z');

  beforeEach(() => {
    prisma = {
      reinspection: { findMany: jest.fn().mockResolvedValue([]) },
    };
    gerar = {
      processar: jest
        .fn()
        .mockResolvedValue({ status: 'GERADO', pulado: false }),
    };
    servico = new BoletoRetryVarreduraService(
      new BoletoReativacaoRepository(prisma as unknown as PrismaService),
      gerar as unknown as GerarBoletoReativacaoService,
    );
  });

  it('procura só PENDENTE_RETRY com a tentativa vencida e o lease livre (NAO_GERADO e FALHA ficam de fora)', async () => {
    await servico.executar(agora);

    expect(prisma.reinspection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          boletoStatus: 'PENDENTE_RETRY',
          AND: [
            {
              OR: [
                { boletoProximaTentativaEm: null },
                { boletoProximaTentativaEm: { lte: agora } },
              ],
            },
            {
              OR: [{ boletoLeaseAte: null }, { boletoLeaseAte: { lt: agora } }],
            },
          ],
        },
      }),
    );
    expect(gerar.processar).not.toHaveBeenCalled();
  });

  it('dispara UMA tentativa (origem RETRY) por revistoria vencida e resume o desfecho', async () => {
    prisma.reinspection.findMany.mockResolvedValue([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
    ]);
    gerar.processar
      .mockResolvedValueOnce({ status: 'GERADO', pulado: false })
      .mockResolvedValueOnce({ status: 'PENDENTE_RETRY', pulado: false })
      .mockResolvedValueOnce({ status: 'FALHA', pulado: false })
      .mockResolvedValueOnce({ status: 'PENDENTE_RETRY', pulado: true });

    const resumo = await servico.executar(agora);

    expect(gerar.processar.mock.calls).toEqual([
      [1, { origem: 'RETRY' }],
      [2, { origem: 'RETRY' }],
      [3, { origem: 'RETRY' }],
      [4, { origem: 'RETRY' }],
    ]);
    expect(resumo).toEqual({
      vencidas: 4,
      gerados: 1,
      reagendados: 1,
      falhas: 1,
      pulados: 1,
    });
  });

  it('uma revistoria que estoura não impede as demais; a rodada termina como falha', async () => {
    prisma.reinspection.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    gerar.processar
      .mockRejectedValueOnce(new Error('banco fora'))
      .mockResolvedValueOnce({ status: 'GERADO', pulado: false });

    await expect(servico.executar(agora)).rejects.toThrow(
      /1 de 2 tentativa\(s\) não concluíram — revistoria 1: banco fora/,
    );
    expect(gerar.processar).toHaveBeenCalledTimes(2);
  });
});

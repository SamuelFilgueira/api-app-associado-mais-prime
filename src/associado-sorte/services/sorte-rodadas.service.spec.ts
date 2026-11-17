import { Test } from '@nestjs/testing';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SortePremiosRepository } from 'src/associado-sorte/repositories/sorte-premios.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteRodadasService } from 'src/associado-sorte/services/sorte-rodadas.service';
import { SorteTxMemoria } from 'src/associado-sorte/testing/sorte-tx.memoria';

describe('SorteRodadasService', () => {
  let service: SorteRodadasService;
  let tx: SorteTxMemoria;

  const RODADA = 5;
  const PREMIO = 2;
  const autor = { id: 99, nome: 'Marketing' };

  const repository = { buscarAdmin: jest.fn(), criar: jest.fn() };
  const premiosRepository = { buscar: jest.fn() };

  /** Espelha a rodada do dublê no formato que o repositório devolve. */
  const espelhar = () =>
    repository.buscarAdmin.mockImplementation((id: number) => {
      const r = tx.rodadas.get(id);
      if (!r) return Promise.resolve(null);
      return Promise.resolve({
        ...r,
        apuradaEm: null,
        resumoApuracao: null,
        lembreteEnviadoEm: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        premio: { id: r.premioId, nome: 'Prêmio', imagemUrl: null, estoque: 3 },
        bases: (tx.bases.get(id) ?? ['MAIS_PRIME']).map((baseOrigin) => ({
          baseOrigin,
        })),
        _count: { participacoes: 0, ganhadores: 0 },
      });
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    tx = new SorteTxMemoria()
      .comRodada({
        id: RODADA,
        premioId: PREMIO,
        mecanica: 'SORTEIO',
        quantidade: 2,
        custoCreditos: 3,
        bilhetesMaximos: 5,
      })
      .comPremio(PREMIO, 3);
    espelhar();
    premiosRepository.buscar.mockResolvedValue({ id: PREMIO, ativo: true });

    const module = await Test.createTestingModule({
      providers: [
        SorteRodadasService,
        SorteCreditosService,
        { provide: SorteRodadasRepository, useValue: repository },
        { provide: SortePremiosRepository, useValue: premiosRepository },
        { provide: SorteCreditosRepository, useValue: {} },
        { provide: SorteUnidadeTrabalho, useValue: tx.unidadeDeTrabalho() },
        {
          provide: SorteGanhadoresService,
          useValue: { listarDaRodada: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();
    service = module.get(SorteRodadasService);
  });

  describe('cancelar', () => {
    beforeEach(() => {
      tx.comCarteira(1, 4)
        .comCarteira(2, 0)
        .comCarteira(3, 10)
        .comParticipacao({
          rodadaId: RODADA,
          userId: 2,
          bilhetes: 3,
          creditosGastos: 9,
        })
        .comParticipacao({
          rodadaId: RODADA,
          userId: 1,
          bilhetes: 2,
          creditosGastos: 6,
        })
        // SALDO_MINIMO: participou sem gastar; não há o que estornar.
        .comParticipacao({
          rodadaId: RODADA,
          userId: 3,
          bilhetes: 1,
          creditosGastos: 0,
        });
    });

    it('devolve os créditos consumidos com lançamento ESTORNO', async () => {
      const r = await service.cancelar(RODADA, autor);

      expect(r.estado).toBe('CANCELADA');
      expect(tx.saldo(1)).toBe(10);
      expect(tx.saldo(2)).toBe(9);
      expect(tx.saldo(3)).toBe(10);
      expect(tx.lancamentos).toHaveLength(2);
      expect(tx.lancamentos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: 1,
            tipo: 'ESTORNO',
            valor: 6,
            saldoApos: 10,
            rodadaId: RODADA,
            autorId: 99,
            autorNome: 'Marketing',
          }),
          expect.objectContaining({
            userId: 2,
            tipo: 'ESTORNO',
            valor: 9,
            saldoApos: 9,
          }),
        ]),
      );
    });

    it('estorno não conta como crédito ganho', async () => {
      await service.cancelar(RODADA, autor);
      expect(tx.carteiras.get(1)!.totalGanho).toBe(0);
    });

    it('trava a rodada e depois as carteiras em ordem crescente', async () => {
      await service.cancelar(RODADA, autor);
      expect(tx.travas).toEqual([
        `rodada:${RODADA}`,
        'carteira:1',
        'carteira:2',
      ]);
    });

    it('marca as participações como estornadas', async () => {
      await service.cancelar(RODADA, autor);
      expect(tx.participacoes.every((p) => p.estornadoEm instanceof Date)).toBe(
        true,
      );
    });

    it('cancelar de novo não estorna em dobro', async () => {
      await service.cancelar(RODADA, autor);
      await service.cancelar(RODADA, autor);

      expect(tx.saldo(1)).toBe(10);
      expect(tx.saldo(2)).toBe(9);
      expect(tx.lancamentos).toHaveLength(2);
    });

    it('não mexe no estoque do prêmio', async () => {
      await service.cancelar(RODADA, autor);
      expect(tx.premios.get(PREMIO)!.estoque).toBe(3);
      expect(tx.movimentos).toHaveLength(0);
    });

    it('rodada encerrada não pode ser cancelada → 409', async () => {
      tx.rodadas.get(RODADA)!.estado = 'ENCERRADA';

      await expect(service.cancelar(RODADA, autor)).rejects.toMatchObject({
        response: { code: 'RODADA_ENCERRADA' },
      });
      expect(tx.saldo(1)).toBe(4);
    });
  });

  describe('publicar', () => {
    beforeEach(() => {
      tx.rodadas.get(RODADA)!.estado = 'RASCUNHO';
    });

    it('publica quando a quantidade cabe no estoque', async () => {
      const r = await service.publicar(RODADA, autor);
      expect(r.estado).toBe('PUBLICADA');
      expect(tx.travas).toEqual([`rodada:${RODADA}`, `premio:${PREMIO}`]);
    });

    it('desconta as unidades restantes de outras rodadas publicadas do prêmio', async () => {
      tx.comRodada({
        id: 6,
        premioId: PREMIO,
        quantidade: 2,
        quantidadeRestante: 2,
      });

      await expect(service.publicar(RODADA, autor)).rejects.toMatchObject({
        response: {
          code: 'ESTOQUE_INSUFICIENTE',
          estoque: 3,
          reservado: 2,
          disponivel: 1,
        },
        status: 422,
      });
      expect(tx.rodadas.get(RODADA)!.estado).toBe('RASCUNHO');
    });

    it('rascunhos e rodadas encerradas não reservam estoque', async () => {
      tx.comRodada({
        id: 6,
        premioId: PREMIO,
        quantidade: 3,
        estado: 'RASCUNHO',
      });
      tx.comRodada({
        id: 7,
        premioId: PREMIO,
        quantidade: 3,
        estado: 'ENCERRADA',
      });
      await expect(service.publicar(RODADA, autor)).resolves.toMatchObject({
        estado: 'PUBLICADA',
      });
    });

    it('encerramento no passado → 422 PERIODO_INVALIDO', async () => {
      tx.rodadas.get(RODADA)!.encerramento = new Date(Date.now() - 1000);
      await expect(service.publicar(RODADA, autor)).rejects.toMatchObject({
        response: { code: 'PERIODO_INVALIDO' },
      });
    });

    it('só rascunho é publicado', async () => {
      tx.rodadas.get(RODADA)!.estado = 'PUBLICADA';
      await expect(service.publicar(RODADA, autor)).rejects.toMatchObject({
        response: { code: 'RODADA_NAO_RASCUNHO' },
      });
    });
  });

  describe('atualizar', () => {
    it('depois da abertura, mudar custo, mecânica ou prêmio → 409 EDICAO_BLOQUEADA', async () => {
      for (const dto of [
        { custoCreditos: 1 },
        { mecanica: 'CORRIDA' as const },
        { premioId: 77 },
        { quantidade: 9 },
      ]) {
        await expect(service.atualizar(RODADA, dto)).rejects.toMatchObject({
          response: { code: 'EDICAO_BLOQUEADA' },
        });
      }
      expect(tx.rodadas.get(RODADA)).toMatchObject({
        custoCreditos: 3,
        mecanica: 'SORTEIO',
        premioId: PREMIO,
      });
    });

    it('depois da abertura, título e encerramento ainda mudam', async () => {
      const encerramento = new Date(Date.now() + 7_200_000);

      await service.atualizar(RODADA, {
        titulo: '  Novo título  ',
        encerramento: encerramento.toISOString(),
      });

      expect(tx.rodadas.get(RODADA)).toMatchObject({
        titulo: 'Novo título',
        encerramento,
        custoCreditos: 3,
      });
    });

    it('reenviar o formulário inteiro sem mudar regra não é bloqueado', async () => {
      const atual = tx.rodadas.get(RODADA)!;
      await expect(
        service.atualizar(RODADA, {
          premioId: atual.premioId,
          mecanica: atual.mecanica,
          quantidade: atual.quantidade,
          custoCreditos: atual.custoCreditos,
          abertura: atual.abertura.toISOString(),
          baseOrigins: ['MAIS_PRIME'],
          titulo: 'Só o título',
        }),
      ).resolves.toBeDefined();
    });

    it('rascunho aceita tudo; vitrine força CONSOME e um bilhete', async () => {
      tx.rodadas.get(RODADA)!.estado = 'RASCUNHO';

      await service.atualizar(RODADA, {
        mecanica: 'RESGATE',
        modoCredito: 'SALDO_MINIMO',
        bilhetesMaximos: 9,
        quantidade: 4,
      });

      expect(tx.rodadas.get(RODADA)).toMatchObject({
        mecanica: 'RESGATE',
        modoCredito: 'CONSOME',
        bilhetesMaximos: 1,
        quantidade: 4,
        quantidadeRestante: 4,
      });
    });

    it('encerramento antes da abertura → 422 PERIODO_INVALIDO', async () => {
      tx.rodadas.get(RODADA)!.estado = 'RASCUNHO';
      await expect(
        service.atualizar(RODADA, {
          encerramento: new Date(Date.now() - 86_400_000).toISOString(),
        }),
      ).rejects.toMatchObject({ response: { code: 'PERIODO_INVALIDO' } });
    });

    it('base desconhecida → 422 BASE_INVALIDA', async () => {
      await expect(
        service.atualizar(RODADA, { baseOrigins: ['OUTRA_EMPRESA'] }),
      ).rejects.toMatchObject({ response: { code: 'BASE_INVALIDA' } });
    });

    it('rodada encerrada não é editável', async () => {
      tx.rodadas.get(RODADA)!.estado = 'ENCERRADA';
      await expect(
        service.atualizar(RODADA, { titulo: 'x' }),
      ).rejects.toMatchObject({ response: { code: 'RODADA_ENCERRADA' } });
    });
  });

  it('duplicar cria N rascunhos independentes, de 7 em 7 dias', async () => {
    repository.criar.mockImplementation(({ data, baseOrigins }) =>
      Promise.resolve({
        id: 100,
        ...data,
        apuradaEm: null,
        resumoApuracao: null,
        lembreteEnviadoEm: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        premio: { id: PREMIO, nome: 'Prêmio', imagemUrl: null, estoque: 3 },
        bases: baseOrigins.map((baseOrigin: string) => ({ baseOrigin })),
        _count: { participacoes: 0, ganhadores: 0 },
      }),
    );
    const origem = tx.rodadas.get(RODADA)!;
    const semana = 7 * 24 * 60 * 60 * 1000;

    const r = await service.duplicar(RODADA, 3);

    expect(r.data).toHaveLength(3);
    expect(repository.criar).toHaveBeenCalledTimes(3);
    repository.criar.mock.calls.forEach(([{ data, baseOrigins }], i) => {
      expect(data.estado).toBe('RASCUNHO');
      expect(data.abertura.getTime()).toBe(
        origem.abertura.getTime() + (i + 1) * semana,
      );
      expect(data.encerramento.getTime()).toBe(
        origem.encerramento.getTime() + (i + 1) * semana,
      );
      expect(data.quantidadeRestante).toBe(origem.quantidade);
      expect(baseOrigins).toEqual(['MAIS_PRIME']);
    });
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-argument -- spec com dublês em memória: registros soltos, conferidos pelas asserções */
import { Test } from '@nestjs/testing';
import { hashCronograma } from 'src/associado-sorte/helpers/sorte-cronograma.helper';
import { SorteCampanhasRepository } from 'src/associado-sorte/repositories/sorte-campanhas.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteTxMemoria } from 'src/associado-sorte/testing/sorte-tx.memoria';

describe('SorteCampanhaService', () => {
  let service: SorteCampanhaService;
  let tx: SorteTxMemoria;

  const autor = { id: 3, nome: 'Marketing' };
  const futuro = (dias: number) => new Date(Date.now() + dias * 86_400_000);

  /** O repositório lê o mesmo estado do dublê. */
  const repository = {
    buscar: jest.fn((id: number) => {
      const c = tx.campanhas.get(id);
      return Promise.resolve(
        c ? { ...c, createdAt: new Date(), updatedAt: new Date() } : null,
      );
    }),
    contarMomentos: jest.fn(() => Promise.resolve(new Map())),
    buscarMomento: jest.fn((id: number) =>
      Promise.resolve(tx.momentos.find((m) => m.id === id) ?? null),
    ),
    excluirRascunho: jest.fn(),
  };

  const codigo = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: { getResponse?: () => { code?: string }; message?: string }) =>
        e.getResponse?.()?.code ?? e.message ?? 'ERRO',
    );

  const CSV = (linhas: string[]) =>
    ['data;hora;creditos;descricao', ...linhas].join('\n');
  const dataBr = (d: Date) => {
    const sp = new Date(d.getTime() - 3 * 3_600_000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${p2(sp.getUTCDate())}/${p2(sp.getUTCMonth() + 1)}/${sp.getUTCFullYear()}`;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    tx = new SorteTxMemoria()
      .comCampanha({
        id: 1,
        nome: 'Campanha 2027',
        estado: 'RASCUNHO',
        inicio: futuro(-1),
        fim: futuro(30),
      })
      .comCampanha({
        id: 2,
        nome: 'Publicada',
        estado: 'PUBLICADA',
        inicio: futuro(-1),
        fim: futuro(30),
      })
      .comMomento({
        id: 900,
        campanhaId: 2,
        liberaEm: futuro(1),
        creditos: 120,
      });
    const module = await Test.createTestingModule({
      providers: [
        SorteCampanhaService,
        { provide: SorteCampanhasRepository, useValue: repository },
        { provide: SorteUnidadeTrabalho, useValue: tx.unidadeDeTrabalho() },
      ],
    }).compile();
    service = module.get(SorteCampanhaService);
  });

  describe('campanha publicada (travada) recusa edição', () => {
    it.each([
      [
        'criar momento',
        () =>
          service.criarMomento(2, {
            liberaEm: futuro(2).toISOString(),
            creditos: 10,
          }),
      ],
      [
        'editar momento',
        () => service.atualizarMomento(2, 900, { creditos: 999 }),
      ],
      ['apagar momento', () => service.excluirMomento(2, 900)],
      [
        'importar CSV',
        () =>
          service.importar(
            2,
            { csv: CSV([`${dataBr(futuro(2))};10:00;120;x`]) },
            autor,
          ),
      ],
      [
        'mudar início',
        () => service.atualizar(2, { inicio: futuro(-2).toISOString() }),
      ],
      [
        'mudar fim',
        () => service.atualizar(2, { fim: futuro(40).toISOString() }),
      ],
      ['excluir a campanha', () => service.excluir(2)],
    ])('%s → 409 CAMPANHA_TRAVADA', async (_nome, acao) => {
      await expect(codigo(acao())).resolves.toBe('CAMPANHA_TRAVADA');
      expect(tx.momentos).toEqual([
        expect.objectContaining({ id: 900, creditos: 120, userId: null }),
      ]);
    });

    it('o nome continua editável', async () => {
      await service.atualizar(2, { nome: 'Novo nome' });
      expect(tx.campanhas.get(2)!.nome).toBe('Novo nome');
    });
  });

  describe('rascunho', () => {
    it('importa o CSV (tudo ou nada) e publica gravando o SHA-256', async () => {
      const d = dataBr(futuro(2));
      const invalido = service.importar(
        1,
        { csv: CSV([`${d};10:00;120;ok`, `${d};99:00;120;ruim`]) },
        autor,
      );
      await expect(
        invalido.catch((e: { getResponse: () => unknown }) => e.getResponse()),
      ).resolves.toMatchObject({
        code: 'CRONOGRAMA_INVALIDO',
        erros: [{ linha: 3 }],
      });
      expect(tx.momentos.filter((m) => m.campanhaId === 1)).toHaveLength(0);

      await service.importar(
        1,
        {
          csv: CSV([
            `${d};10:00;120;A`,
            `${d};10:02;150;B`,
            `${d};10:04;200;C`,
          ]),
        },
        autor,
      );
      expect(tx.momentos.filter((m) => m.campanhaId === 1)).toHaveLength(3);

      // Publicar exige a confirmação com o nome.
      await expect(
        codigo(service.publicar(1, { confirmacao: 'outro nome' }, autor)),
      ).resolves.toBe('CONFIRMACAO_INVALIDA');
      // Só uma publicada por base.
      await expect(
        codigo(service.publicar(1, { confirmacao: 'Campanha 2027' }, autor)),
      ).resolves.toBe('CAMPANHA_JA_PUBLICADA');

      tx.campanhas.get(2)!.estado = 'ENCERRADA';
      await service.publicar(1, { confirmacao: ' campanha 2027 ' }, autor);
      const publicada = tx.campanhas.get(1)!;
      expect(publicada.estado).toBe('PUBLICADA');
      const momentos = tx.momentos.filter((m) => m.campanhaId === 1);
      expect(publicada.hashCronograma).toBe(
        hashCronograma(publicada, momentos),
      );
      expect(tx.campanhas.get(1)).toMatchObject({
        publicadaPorNome: 'Marketing',
      });

      // Agora está travada.
      await expect(
        codigo(service.excluirMomento(1, momentos[0].id)),
      ).resolves.toBe('CAMPANHA_TRAVADA');
    });

    it('não publica sem cronograma', async () => {
      await expect(
        codigo(service.publicar(1, { confirmacao: 'Campanha 2027' }, autor)),
      ).resolves.toBe('CRONOGRAMA_VAZIO');
    });

    it('momento fora do período é recusado', async () => {
      await expect(
        codigo(
          service.criarMomento(1, {
            liberaEm: futuro(60).toISOString(),
            creditos: 10,
          }),
        ),
      ).resolves.toBe('MOMENTOS_FORA_DO_PERIODO');
    });
  });

  it('encerrar fica registrado e não tem volta', async () => {
    await service.encerrar(2, { motivo: 'Antecipado' }, autor);
    expect(tx.campanhas.get(2)).toMatchObject({
      estado: 'ENCERRADA',
      encerradaPorNome: 'Marketing',
      motivoEncerramento: 'Antecipado',
    });
    await expect(
      codigo(service.encerrar(2, { motivo: 'de novo' }, autor)),
    ).resolves.toBe('CAMPANHA_ENCERRADA');
    await expect(
      codigo(service.atualizarMomento(2, 900, { creditos: 1 })),
    ).resolves.toBe('CAMPANHA_TRAVADA');
  });
});

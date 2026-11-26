/* eslint-disable @typescript-eslint/no-unsafe-argument -- spec com dublês em memória: registros soltos, conferidos pelas asserções */
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SorteConfigView } from 'src/associado-sorte/mappers/sorte.mapper';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteRaspadasRepository } from 'src/associado-sorte/repositories/sorte-raspadas.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteCampanhaService } from 'src/associado-sorte/services/sorte-campanha.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteRateLimitService } from 'src/associado-sorte/services/sorte-rate-limit.service';
import { SorteRaspadinhaService } from 'src/associado-sorte/services/sorte-raspadinha.service';
import { SorteTentativaService } from 'src/associado-sorte/services/sorte-tentativa.service';
import { configDeTeste } from 'src/associado-sorte/testing/sorte-fixtures';
import { SorteTxMemoria } from 'src/associado-sorte/testing/sorte-tx.memoria';

/** Instante a partir de "yyyy-mm-ddTHH:MM[:SS]" em São Paulo. */
const sp = (texto: string) =>
  new Date(`${texto}${texto.length === 16 ? ':00' : ''}.000-03:00`);

describe('SorteRaspadinhaService', () => {
  let service: SorteRaspadinhaService;
  let tx: SorteTxMemoria;
  let config: SorteConfigView;

  const CAMPANHA = 1;
  const campanha = {
    id: CAMPANHA,
    baseOrigin: 'MAIS_PRIME',
    nome: 'Campanha',
    inicio: sp('2026-11-01T00:00'),
    fim: sp('2026-12-31T23:59'),
    estado: 'PUBLICADA',
  };
  const acesso = { validar: jest.fn() };
  const rateLimit = { verificar: jest.fn() };
  const campanhas = { publicadaDaBase: jest.fn() };
  const creditosRepository = { garantirCarteira: jest.fn() };
  const tentativas = { registrarErro: jest.fn() };

  const raspar = (userId: number, agora: Date) =>
    service.raspar({ userId, baseOrigin: 'MAIS_PRIME', agora });

  /** Código do erro de negócio (ou "OK"). */
  const codigo = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: { getResponse?: () => { code?: string }; message?: string }) =>
        e.getResponse?.()?.code ?? e.message ?? 'ERRO',
    );

  async function montar(extra: Partial<SorteConfigView> = {}) {
    config = configDeTeste({
      raspadasPorDia: 5,
      intervaloMinimoMinutos: 0,
      ...extra,
    });
    acesso.validar.mockResolvedValue({ config });
    const module = await Test.createTestingModule({
      providers: [
        SorteRaspadinhaService,
        SorteCreditosService,
        { provide: SorteCreditosRepository, useValue: creditosRepository },
        { provide: SorteRaspadasRepository, useValue: {} },
        { provide: SorteUnidadeTrabalho, useValue: tx.unidadeDeTrabalho() },
        { provide: SorteAcessoService, useValue: acesso },
        { provide: SorteRateLimitService, useValue: rateLimit },
        { provide: SorteCampanhaService, useValue: campanhas },
        { provide: SorteTentativaService, useValue: tentativas },
      ],
    }).compile();
    service = module.get(SorteRaspadinhaService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    tx = new SorteTxMemoria().comCampanha({ id: CAMPANHA });
    for (let u = 1; u <= 10; u++) tx.comCarteira(u, 0);
    campanhas.publicadaDaBase.mockResolvedValue(campanha);
    await montar();
  });

  describe('momento premiado', () => {
    beforeEach(() => {
      tx.comMomento({
        id: 500,
        campanhaId: CAMPANHA,
        liberaEm: sp('2026-11-20T15:00'),
        creditos: 120,
        descricao: 'Voucher das 15h',
      });
    });

    it('não sai às 14:59:59 e sai às 15:00:00', async () => {
      const antes = await raspar(1, sp('2026-11-20T14:59:59'));
      expect(antes.resultado).toBe('NAO_GANHOU');
      expect(antes.creditos).toBe(0);
      expect(tx.momentos[0].userId).toBeNull();

      const na = await raspar(2, sp('2026-11-20T15:00:00'));
      expect(na).toMatchObject({
        resultado: 'GANHOU',
        creditos: 120,
        saldo: 120,
        voucher: { momentoId: 500, descricao: 'Voucher das 15h' },
      });
      expect(tx.momentos[0]).toMatchObject({
        userId: 2,
        ganhoEm: sp('2026-11-20T15:00:00'),
        raspadaId: na.raspadaId,
      });
      expect(tx.saldo(2)).toBe(120);
      expect(tx.lancamentos).toEqual([
        expect.objectContaining({
          userId: 2,
          tipo: 'VOUCHER_RASPADINHA',
          valor: 120,
          saldoApos: 120,
          descricao: 'Voucher das 15h',
        }),
      ]);
      // A raspada perdida e a vencedora ficam no histórico.
      expect(tx.raspadas.map((r) => [r.userId, r.resultado])).toEqual([
        [1, 'NAO_GANHOU'],
        [2, 'GANHOU'],
      ]);
    });

    it('10 raspadas simultâneas com 1 momento liberado → exatamente 1 ganhador', async () => {
      const agora = sp('2026-11-20T15:30');
      const resultados = await Promise.all(
        Array.from({ length: 10 }, (_, i) => raspar(i + 1, agora)),
      );
      const ganhadores = resultados.filter((r) => r.resultado === 'GANHOU');
      expect(ganhadores).toHaveLength(1);
      expect(tx.raspadas).toHaveLength(10);
      expect(
        tx.lancamentos.filter((l) => l.tipo === 'VOUCHER_RASPADINHA'),
      ).toHaveLength(1);
      const vencedor = tx.momentos[0].userId;
      expect(tx.saldo(vencedor)).toBe(120);
      const somaSaldos = [...tx.carteiras.values()].reduce(
        (s, c) => s + c.saldo,
        0,
      );
      expect(somaSaldos).toBe(120);
    });

    it('momento não ganho ontem sai hoje', async () => {
      // Ninguém raspou depois das 15h de ontem.
      const r = await raspar(3, sp('2026-11-21T08:10'));
      expect(r.resultado).toBe('GANHOU');
      expect(tx.momentos[0].userId).toBe(3);
    });

    it('sai o mais antigo primeiro; o próximo continua disponível', async () => {
      tx.comMomento({
        id: 501,
        campanhaId: CAMPANHA,
        liberaEm: sp('2026-11-20T15:02'),
        creditos: 200,
      });
      const a = await raspar(1, sp('2026-11-20T15:05'));
      const b = await raspar(2, sp('2026-11-20T15:05'));
      const c = await raspar(3, sp('2026-11-20T15:05'));
      expect([a.creditos, b.creditos, c.creditos]).toEqual([120, 200, 0]);
    });

    it('o mesmo associado pode ganhar vários vouchers (sem carência)', async () => {
      tx.comMomento({
        id: 502,
        campanhaId: CAMPANHA,
        liberaEm: sp('2026-11-20T15:01'),
        creditos: 150,
      });
      await raspar(4, sp('2026-11-20T16:00'));
      const segunda = await raspar(4, sp('2026-11-20T16:01'));
      expect(segunda).toMatchObject({ resultado: 'GANHOU', saldo: 270 });
    });

    it('carência: quem ganhou há menos de carenciaDias raspa sem olhar os momentos', async () => {
      await montar({ carenciaDias: 2 });
      tx.comMomento({
        id: 503,
        campanhaId: CAMPANHA,
        liberaEm: sp('2026-11-20T15:01'),
        creditos: 150,
      });
      const primeira = await raspar(5, sp('2026-11-20T16:00'));
      expect(primeira.resultado).toBe('GANHOU');

      const emCarencia = await raspar(5, sp('2026-11-21T16:00'));
      expect(emCarencia.resultado).toBe('NAO_GANHOU');
      expect(tx.momentos.find((m) => m.id === 503).userId).toBeNull();

      const outro = await raspar(6, sp('2026-11-21T16:00'));
      expect(outro.resultado).toBe('GANHOU');

      // Passou a carência (2 dias depois do voucher): volta a concorrer.
      tx.comMomento({
        id: 504,
        campanhaId: CAMPANHA,
        liberaEm: sp('2026-11-22T10:00'),
        creditos: 120,
      });
      const depois = await raspar(5, sp('2026-11-22T16:01'));
      expect(depois.resultado).toBe('GANHOU');
    });
  });

  describe('limite diário e intervalo (dia em São Paulo)', () => {
    beforeEach(() => montar({ raspadasPorDia: 2, intervaloMinimoMinutos: 60 }));

    it('o 409 de intervalo e de limite traz a última raspada do dia (quem perdeu a resposta vê o resultado)', async () => {
      const r1 = await raspar(7, sp('2026-11-20T21:00'));

      const intervalo = await raspar(7, sp('2026-11-20T21:30')).catch(
        (e: { getResponse: () => Record<string, unknown> }) => e.getResponse(),
      );
      expect(intervalo).toMatchObject({
        code: 'INTERVALO',
        ultimaRaspada: {
          raspadaId: r1.raspadaId,
          resultado: r1.resultado,
          creditos: r1.creditos,
        },
      });

      const r2 = await raspar(7, sp('2026-11-20T22:00'));
      const limite = await raspar(7, sp('2026-11-20T23:30')).catch(
        (e: { getResponse: () => Record<string, unknown> }) => e.getResponse(),
      );
      expect(limite).toMatchObject({
        code: 'LIMITE_DIARIO',
        ultimaRaspada: { raspadaId: r2.raspadaId },
      });
    });

    it('INTERVALO antes de 60 min, LIMITE_DIARIO na terceira e volta a 2 à 00:00', async () => {
      const r1 = await raspar(7, sp('2026-11-20T21:00'));
      expect(r1).toMatchObject({
        raspadasRestantesHoje: 1,
        proximaRaspadaEm: sp('2026-11-20T22:00'),
      });

      const intervalo = raspar(7, sp('2026-11-20T21:30'));
      await expect(intervalo).rejects.toBeInstanceOf(ConflictException);
      await expect(codigo(raspar(7, sp('2026-11-20T21:59:59')))).resolves.toBe(
        'INTERVALO',
      );

      const r2 = await raspar(7, sp('2026-11-20T22:00'));
      expect(r2).toMatchObject({
        raspadasRestantesHoje: 0,
        proximaRaspadaEm: sp('2026-11-21T00:00'),
      });

      const limite = await raspar(7, sp('2026-11-20T23:30')).catch(
        (e: { getResponse: () => Record<string, unknown> }) => e.getResponse(),
      );
      expect(limite).toMatchObject({
        code: 'LIMITE_DIARIO',
        proximaRaspadaEm: sp('2026-11-21T00:00'),
      });

      // 00:00 em São Paulo (03:00 UTC): o contador volta a 2, sem acumular.
      const r3 = await raspar(7, sp('2026-11-21T00:00'));
      expect(r3.raspadasRestantesHoje).toBe(1);
      expect(tx.raspadas).toHaveLength(3);
      // As recusas viraram tentativas (registradas fora da transação).
      expect(tentativas.registrarErro).toHaveBeenCalledTimes(3);
      expect(tentativas.registrarErro).toHaveBeenCalledWith(
        expect.objectContaining({ acao: 'RASPAR', userId: 7 }),
      );
    });

    it('10 raspadas simultâneas do mesmo associado respeitam o limite do dia', async () => {
      await montar({ raspadasPorDia: 2, intervaloMinimoMinutos: 0 });
      const codigos = await Promise.all(
        Array.from({ length: 10 }, () =>
          codigo(raspar(8, sp('2026-11-20T10:00'))),
        ),
      );
      expect(codigos.filter((c) => c === 'OK')).toHaveLength(2);
      expect(codigos.filter((c) => c === 'LIMITE_DIARIO')).toHaveLength(8);
      expect(tx.raspadas.filter((r) => r.userId === 8)).toHaveLength(2);
    });
  });

  describe('campanha', () => {
    it('SEM_CAMPANHA sem campanha publicada', async () => {
      campanhas.publicadaDaBase.mockResolvedValue(null);
      await expect(codigo(raspar(1, sp('2026-11-20T10:00')))).resolves.toBe(
        'SEM_CAMPANHA',
      );
    });

    it('CAMPANHA_FORA_DO_PERIODO antes do início e depois do fim', async () => {
      await expect(codigo(raspar(1, sp('2026-10-31T23:59')))).resolves.toBe(
        'CAMPANHA_FORA_DO_PERIODO',
      );
      await expect(codigo(raspar(1, sp('2027-01-01T00:00')))).resolves.toBe(
        'CAMPANHA_FORA_DO_PERIODO',
      );
      expect(tx.raspadas).toHaveLength(0);
    });
  });

  describe('jornada de check-in', () => {
    const marcos = [{ dias: 3, bonus: 25 }];

    it('ligada: o bônus entra uma vez, na primeira raspada do 3º dia seguido', async () => {
      await montar({ jornadaAtiva: true, marcosSequencia: marcos });
      const d1 = await raspar(9, sp('2026-11-20T10:00'));
      const d2 = await raspar(9, sp('2026-11-21T10:00'));
      const d3 = await raspar(9, sp('2026-11-22T10:00'));
      const d3b = await raspar(9, sp('2026-11-22T11:00'));

      expect([d1, d2, d3, d3b].map((r) => r.bonusJornada)).toEqual([
        0, 0, 25, 0,
      ]);
      expect(d3.jornada).toMatchObject({ sequencia: 3 });
      expect(
        tx.lancamentos.filter((l) => l.tipo === 'BONUS_SEQUENCIA'),
      ).toEqual([expect.objectContaining({ userId: 9, valor: 25 })]);
      expect(tx.saldo(9)).toBe(25);
    });

    it('pular um dia recomeça a sequência', async () => {
      await montar({ jornadaAtiva: true, marcosSequencia: marcos });
      await raspar(9, sp('2026-11-20T10:00'));
      await raspar(9, sp('2026-11-21T10:00'));
      const d4 = await raspar(9, sp('2026-11-23T10:00'));
      expect(d4.bonusJornada).toBe(0);
      expect(d4.jornada?.sequencia).toBe(1);
    });

    it('desligada: nenhum bônus e nada de jornada na resposta', async () => {
      await montar({ jornadaAtiva: false, marcosSequencia: marcos });
      await raspar(9, sp('2026-11-20T10:00'));
      await raspar(9, sp('2026-11-21T10:00'));
      const d3 = await raspar(9, sp('2026-11-22T10:00'));
      expect(d3.bonusJornada).toBe(0);
      expect(d3.jornada).toBeNull();
      expect(tx.lancamentos).toHaveLength(0);
      expect(tx.carteiras.get(9)!.sequenciaDias).toBe(0);
    });
  });
});

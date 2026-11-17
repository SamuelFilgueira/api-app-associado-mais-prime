import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { SorteConfigRepository } from 'src/associado-sorte/repositories/sorte-config.repository';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SorteRodadasRepository } from 'src/associado-sorte/repositories/sorte-rodadas.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteAleatorioService } from 'src/associado-sorte/services/sorte-aleatorio.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';
import { SorteRateLimitService } from 'src/associado-sorte/services/sorte-rate-limit.service';
import { SorteResgateService } from 'src/associado-sorte/services/sorte-resgate.service';
import { configDeTeste } from 'src/associado-sorte/testing/sorte-fixtures';
import { SorteTxMemoria } from 'src/associado-sorte/testing/sorte-tx.memoria';

describe('SorteResgateService', () => {
  let service: SorteResgateService;
  let tx: SorteTxMemoria;

  const RODADA = 1;
  const PREMIO = 50;

  const rodadasRepository = { leituraRapida: jest.fn() };
  const creditosRepository = { garantirCarteira: jest.fn() };
  const ganhadoresRepository = { buscar: jest.fn() };
  const acesso = { validar: jest.fn() };
  const rateLimit = { verificar: jest.fn() };
  const notificacoes = { avisarGanhadores: jest.fn() };
  let sequencia = 0;
  const aleatorio = { inteiro: jest.fn(() => sequencia++ % 30) };

  const resgatar = (userId = 7) =>
    service.resgatar({ rodadaId: RODADA, userId, baseOrigin: 'MAIS_PRIME' });

  /** A recusa rápida lê a rodada sem trava: aqui, direto do dublê. */
  const leituraDoDuble = () =>
    rodadasRepository.leituraRapida.mockImplementation((id: number) => {
      const r = tx.rodadas.get(id);
      return Promise.resolve(r ? { ...r } : null);
    });

  async function montar(uow?: Partial<SorteUnidadeTrabalho>) {
    const module = await Test.createTestingModule({
      providers: [
        SorteResgateService,
        SorteCreditosService,
        SorteGanhadoresService,
        { provide: SorteRodadasRepository, useValue: rodadasRepository },
        { provide: SorteCreditosRepository, useValue: creditosRepository },
        { provide: SorteGanhadoresRepository, useValue: ganhadoresRepository },
        { provide: SorteConfigRepository, useValue: {} },
        { provide: SorteConfigService, useValue: {} },
        {
          provide: SorteUnidadeTrabalho,
          useValue: uow ?? tx.unidadeDeTrabalho(),
        },
        { provide: SorteAcessoService, useValue: acesso },
        { provide: SorteRateLimitService, useValue: rateLimit },
        { provide: SorteAleatorioService, useValue: aleatorio },
        { provide: SorteNotificacoesService, useValue: notificacoes },
      ],
    }).compile();
    service = module.get(SorteResgateService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    sequencia = 0;
    tx = new SorteTxMemoria()
      .comRodada({
        id: RODADA,
        premioId: PREMIO,
        mecanica: 'RESGATE',
        quantidade: 2,
        custoCreditos: 15,
      })
      .comPremio(PREMIO, 5)
      .comCarteira(7, 40)
      .comCarteira(8, 40);
    leituraDoDuble();
    acesso.validar.mockResolvedValue({ config: configDeTeste() });
    notificacoes.avisarGanhadores.mockResolvedValue(undefined);
    ganhadoresRepository.buscar.mockImplementation((id: number) => {
      const g = tx.ganhadores.find((x) => x.id === id);
      return Promise.resolve({
        ...g,
        telefoneContato: null,
        telefoneConfirmadoEm: null,
        entregueEm: null,
        premio: {
          id: PREMIO,
          nome: 'Prêmio 50',
          descricao: null,
          imagemUrl: null,
        },
        rodada: {
          id: RODADA,
          titulo: 'Vitrine',
          mecanica: 'RESGATE',
          abertura: new Date(),
        },
        user: { id: g.userId, name: 'Fulano de Tal', cpf: '12345678909' },
      });
    });
    await montar();
  });

  describe('sucesso', () => {
    it('cria o ganhador, baixa a rodada e o estoque e debita os créditos', async () => {
      const r = await resgatar();

      expect(r.saldo).toBe(25);
      expect(r.ganhador).toMatchObject({
        situacao: 'AGUARDANDO_CONTATO',
        origem: 'RESGATE',
        telefoneConfirmado: false,
      });
      expect(r.ganhador.codigo).toMatch(/^[A-Z2-9]{6}$/);
      expect(r.ganhador.linkWhatsappSuporte).toContain(
        'https://wa.me/5521999990000?text=',
      );

      expect(tx.rodadas.get(RODADA)!.quantidadeRestante).toBe(1);
      expect(tx.premios.get(PREMIO)!.estoque).toBe(4);
      expect(tx.saldo(7)).toBe(25);
      expect(tx.ganhadores).toHaveLength(1);
      expect(tx.ganhadores[0]).toMatchObject({
        rodadaId: RODADA,
        premioId: PREMIO,
        userId: 7,
        baseOrigin: 'MAIS_PRIME',
        creditosGastos: 15,
      });
      expect(tx.movimentos).toEqual([
        expect.objectContaining({
          premioId: PREMIO,
          tipo: 'SAIDA_GANHADOR',
          quantidade: -1,
          estoqueApos: 4,
          ganhadorId: tx.ganhadores[0].id,
        }),
      ]);
      expect(tx.lancamentos).toEqual([
        expect.objectContaining({
          tipo: 'RESGATE',
          valor: -15,
          saldoApos: 25,
          rodadaId: RODADA,
        }),
      ]);
    });

    it('trava sempre na ordem rodada → prêmio → carteira', async () => {
      await resgatar();
      expect(tx.travas).toEqual([
        `rodada:${RODADA}`,
        `premio:${PREMIO}`,
        'carteira:7',
      ]);
    });

    it('avisa o ganhador por push depois da transação', async () => {
      await resgatar();
      expect(notificacoes.avisarGanhadores).toHaveBeenCalledWith([
        tx.ganhadores[0].id,
      ]);
    });

    it('falha de push não desfaz a vitória', async () => {
      notificacoes.avisarGanhadores.mockRejectedValue(new Error('Expo fora'));
      await expect(resgatar()).resolves.toMatchObject({ saldo: 25 });
      expect(tx.ganhadores).toHaveLength(1);
    });

    it('corrida em SALDO_MINIMO: exige o saldo mas não debita', async () => {
      tx.comRodada({
        id: RODADA,
        premioId: PREMIO,
        mecanica: 'CORRIDA',
        modoCredito: 'SALDO_MINIMO',
        custoCreditos: 30,
      });

      const r = await resgatar();

      expect(r.saldo).toBe(40);
      expect(tx.lancamentos).toHaveLength(0);
      expect(tx.ganhadores[0].creditosGastos).toBe(0);
    });

    it('vitrine sempre consome, mesmo se a rodada estiver em SALDO_MINIMO', async () => {
      tx.rodadas.get(RODADA)!.modoCredito = 'SALDO_MINIMO';
      expect((await resgatar()).saldo).toBe(25);
    });
  });

  describe('recusa rápida (sem transação nem trava)', () => {
    const semTransacao = () => {
      expect(tx.travas).toEqual([]);
      expect(creditosRepository.garantirCarteira).not.toHaveBeenCalled();
      expect(tx.ganhadores).toHaveLength(0);
    };

    it('rodada não aberta → 409 RODADA_NAO_ABERTA com o horário do servidor', async () => {
      const abertura = new Date(Date.now() + 60_000);
      tx.rodadas.get(RODADA)!.abertura = abertura;

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'RODADA_NAO_ABERTA', abertura },
      });
      await expect(resgatar()).rejects.toBeInstanceOf(ConflictException);
      semTransacao();
    });

    it('esgotado → 409 ESGOTADO', async () => {
      tx.rodadas.get(RODADA)!.quantidadeRestante = 0;

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'ESGOTADO' },
      });
      semTransacao();
    });

    it('depois do encerramento → 409 RODADA_ENCERRADA', async () => {
      tx.rodadas.get(RODADA)!.encerramento = new Date(Date.now() - 1000);

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'RODADA_ENCERRADA' },
      });
      semTransacao();
    });

    it('rodada de outra base ou inexistente → 404', async () => {
      rodadasRepository.leituraRapida.mockResolvedValue(null);
      await expect(resgatar()).rejects.toBeInstanceOf(NotFoundException);
      expect(rodadasRepository.leituraRapida).toHaveBeenCalledWith(
        RODADA,
        'MAIS_PRIME',
      );
    });
  });

  describe('revalidação dentro da transação (linhas travadas)', () => {
    /** A leitura rápida viu a rodada aberta; a verdade está na linha travada. */
    const leituraDesatualizada = () => {
      const foto = { ...tx.rodadas.get(RODADA)! };
      rodadasRepository.leituraRapida.mockResolvedValue(foto);
    };

    it('esgotou entre a leitura e a trava → 409 ESGOTADO, nada muda', async () => {
      leituraDesatualizada();
      tx.rodadas.get(RODADA)!.quantidadeRestante = 0;

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'ESGOTADO' },
      });
      expect(tx.ganhadores).toHaveLength(0);
      expect(tx.saldo(7)).toBe(40);
    });

    it('estoque zerado por ajuste manual → 409 ESGOTADO, ninguém leva', async () => {
      tx.premios.get(PREMIO)!.estoque = 0;

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'ESGOTADO' },
      });
      expect(tx.rodadas.get(RODADA)!.quantidadeRestante).toBe(2);
      expect(tx.ganhadores).toHaveLength(0);
    });

    it('crédito insuficiente → 422 CREDITOS_INSUFICIENTES, estoque intacto', async () => {
      tx.comCarteira(7, 14);

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'CREDITOS_INSUFICIENTES', saldo: 14, necessario: 15 },
      });
      await expect(resgatar()).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(tx.premios.get(PREMIO)!.estoque).toBe(5);
      expect(tx.rodadas.get(RODADA)!.quantidadeRestante).toBe(2);
      expect(tx.saldo(7)).toBe(14);
      expect(tx.lancamentos).toHaveLength(0);
    });

    it('já ganhou nesta rodada → 409 JA_GANHOU, sem segunda unidade', async () => {
      await resgatar();

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'JA_GANHOU' },
      });
      expect(tx.ganhadores).toHaveLength(1);
      expect(tx.premios.get(PREMIO)!.estoque).toBe(4);
      expect(tx.saldo(7)).toBe(25);
    });

    it('segunda barreira: índice único (rodada, associado) vira JA_GANHOU', async () => {
      const duplicado = new Prisma.PrismaClientKnownRequestError('duplicado', {
        code: 'P2002',
        clientVersion: 'teste',
      });
      await montar({ executar: jest.fn().mockRejectedValue(duplicado) });

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'JA_GANHOU' },
      });
    });

    it('transação sem vaga no pool → 503 TENTE_NOVAMENTE', async () => {
      const semVaga = new Prisma.PrismaClientKnownRequestError('timeout', {
        code: 'P2028',
        clientVersion: 'teste',
      });
      await montar({ executar: jest.fn().mockRejectedValue(semVaga) });

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'TENTE_NOVAMENTE' },
        status: 503,
      });
    });
  });

  describe('carência', () => {
    beforeEach(() => {
      acesso.validar.mockResolvedValue({
        config: configDeTeste({ carenciaDias: 30 }),
      });
      tx.emCarencia.add(7);
    });

    it('corrida: quem ganhou há pouco → 409 EM_CARENCIA', async () => {
      tx.rodadas.get(RODADA)!.mecanica = 'CORRIDA';

      await expect(resgatar()).rejects.toMatchObject({
        response: { code: 'EM_CARENCIA' },
      });
      expect(tx.ganhadores).toHaveLength(0);
      expect(tx.premios.get(PREMIO)!.estoque).toBe(5);
    });

    it('vitrine não tem carência', async () => {
      await expect(resgatar()).resolves.toMatchObject({ saldo: 25 });
    });

    it('carência 0 desliga a regra', async () => {
      acesso.validar.mockResolvedValue({
        config: configDeTeste({ carenciaDias: 0 }),
      });
      tx.rodadas.get(RODADA)!.mecanica = 'CORRIDA';
      await expect(resgatar()).resolves.toBeDefined();
    });
  });

  it('corrida de 1 unidade com vários cliques simultâneos: exatamente um vence', async () => {
    tx.comRodada({
      id: RODADA,
      premioId: PREMIO,
      mecanica: 'CORRIDA',
      quantidade: 1,
      custoCreditos: 0,
    });
    const usuarios = [11, 12, 13, 14, 15, 16, 17, 18];
    usuarios.forEach((id) => tx.comCarteira(id, 0));

    const resultados = await Promise.allSettled(
      usuarios.map((id) => resgatar(id)),
    );

    const venceram = resultados.filter((r) => r.status === 'fulfilled');
    const esgotado = resultados.filter(
      (r) => r.status === 'rejected' && r.reason?.response?.code === 'ESGOTADO',
    );
    expect(venceram).toHaveLength(1);
    expect(esgotado).toHaveLength(usuarios.length - 1);
    expect(tx.ganhadores).toHaveLength(1);
    expect(tx.premios.get(PREMIO)!.estoque).toBe(4);
    expect(tx.rodadas.get(RODADA)!.quantidadeRestante).toBe(0);
  });

  it('sorteio não passa por aqui → 400', async () => {
    tx.rodadas.get(RODADA)!.mecanica = 'SORTEIO';
    await expect(resgatar()).rejects.toMatchObject({ status: 400 });
  });

  it('aplica o limite de requisições antes de ler a rodada', async () => {
    rateLimit.verificar.mockRejectedValueOnce(new Error('429'));

    await expect(resgatar()).rejects.toThrow('429');
    expect(rateLimit.verificar).toHaveBeenCalledWith('resgatar', 7);
    expect(rodadasRepository.leituraRapida).not.toHaveBeenCalled();
  });
});

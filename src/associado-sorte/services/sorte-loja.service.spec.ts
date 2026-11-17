/* eslint-disable @typescript-eslint/no-unsafe-argument -- spec com dublês em memória: registros soltos, conferidos pelas asserções */
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { SORTE_EMAIL_RETIRADA_JOB } from 'src/associado-sorte/config/associado-sorte.config';
import { SorteCreditosRepository } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { SorteGanhadoresRepository } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import { SorteNotificacoesAdminRepository } from 'src/associado-sorte/repositories/sorte-notificacoes-admin.repository';
import { SortePremiosRepository } from 'src/associado-sorte/repositories/sorte-premios.repository';
import { SorteUnidadeTrabalho } from 'src/associado-sorte/repositories/sorte-transacao';
import { SorteAcessoService } from 'src/associado-sorte/services/sorte-acesso.service';
import { SorteAleatorioService } from 'src/associado-sorte/services/sorte-aleatorio.service';
import { SorteConfigService } from 'src/associado-sorte/services/sorte-config.service';
import { SorteCreditosService } from 'src/associado-sorte/services/sorte-creditos.service';
import { SorteGanhadoresService } from 'src/associado-sorte/services/sorte-ganhadores.service';
import { SorteLojaService } from 'src/associado-sorte/services/sorte-loja.service';
import { SorteNotificacoesAdminService } from 'src/associado-sorte/services/sorte-notificacoes-admin.service';
import { SorteNotificacoesService } from 'src/associado-sorte/services/sorte-notificacoes.service';
import { SorteRateLimitService } from 'src/associado-sorte/services/sorte-rate-limit.service';
import { SorteTentativaService } from 'src/associado-sorte/services/sorte-tentativa.service';
import { configDeTeste } from 'src/associado-sorte/testing/sorte-fixtures';
import { SorteTxMemoria } from 'src/associado-sorte/testing/sorte-tx.memoria';
import { MailService } from 'src/infra/mail/mail.service';
import { ASSOCIADO_SORTE_QUEUE } from 'src/queue/queue.module';

describe('SorteLojaService', () => {
  let service: SorteLojaService;
  let tx: SorteTxMemoria;

  const FURADEIRA = 10;
  const GARRAFA = 11;
  let sequencia = 0;
  const aleatorio = { inteiro: jest.fn(() => sequencia++ % 30) };
  const acesso = { validar: jest.fn() };
  const rateLimit = { verificar: jest.fn() };
  const notificacoes = { avisarGanhadores: jest.fn() };
  const tentativas = { registrarErro: jest.fn() };
  const fila = { add: jest.fn() };
  const creditosRepository = { garantirCarteira: jest.fn() };

  const premiosRepository = {
    buscar: jest.fn((id: number) => {
      const p = tx.premios.get(id);
      return Promise.resolve(p ? { ...p } : null);
    }),
  };
  const notificacoesRepository = {
    buscar: jest.fn((id: number) =>
      Promise.resolve(tx.notificacoesAdmin.find((n) => n.id === id) ?? null),
    ),
  };
  const ganhadoresRepository = {
    buscar: jest.fn((id: number) => {
      const g = tx.ganhadores.find((x) => x.id === id);
      const p = tx.premios.get(g.premioId)!;
      return Promise.resolve({
        ...g,
        telefoneContato: null,
        telefoneConfirmadoEm: null,
        entregueEm: null,
        premio: {
          id: p.id,
          nome: p.nome,
          descricao: null,
          imagemUrl: null,
          tipo: p.tipo,
          instrucoesRetirada: 'Retire na sede com o código.',
        },
        rodada: null,
        user: { id: g.userId, name: 'Fulano de Tal', cpf: '12345678909' },
      });
    }),
  };

  const comprar = (premioId: number, userId = 7) =>
    service.comprar({ premioId, userId, baseOrigin: 'MAIS_PRIME' });
  const codigo = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: { getResponse?: () => { code?: string }; message?: string }) =>
        e.getResponse?.()?.code ?? e.message ?? 'ERRO',
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    sequencia = 0;
    tx = new SorteTxMemoria()
      .comPremio(FURADEIRA, 5, {
        nome: 'Furadeira',
        naLoja: true,
        custoCreditos: 120,
        limitePorAssociado: 1,
      })
      .comPremio(GARRAFA, 1, {
        nome: 'Garrafa térmica',
        naLoja: true,
        custoCreditos: 60,
      })
      .comCarteira(7, 300)
      .comCarteira(8, 300)
      .comCarteira(9, 50);
    acesso.validar.mockResolvedValue({
      config: configDeTeste({
        emailNotificacoes: 'marketing@teste.com.br, outro@teste.com.br',
        whatsappMarketing: '5500000000000',
      }),
    });
    notificacoes.avisarGanhadores.mockResolvedValue(undefined);
    fila.add.mockResolvedValue(undefined);

    const module = await Test.createTestingModule({
      providers: [
        SorteLojaService,
        SorteCreditosService,
        SorteGanhadoresService,
        SorteNotificacoesAdminService,
        { provide: SorteCreditosRepository, useValue: creditosRepository },
        { provide: SortePremiosRepository, useValue: premiosRepository },
        { provide: SorteGanhadoresRepository, useValue: ganhadoresRepository },
        {
          provide: SorteNotificacoesAdminRepository,
          useValue: notificacoesRepository,
        },
        { provide: SorteUnidadeTrabalho, useValue: tx.unidadeDeTrabalho() },
        { provide: SorteAcessoService, useValue: acesso },
        { provide: SorteRateLimitService, useValue: rateLimit },
        { provide: SorteAleatorioService, useValue: aleatorio },
        { provide: SorteNotificacoesService, useValue: notificacoes },
        { provide: SorteTentativaService, useValue: tentativas },
        { provide: SorteConfigService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: getQueueToken(ASSOCIADO_SORTE_QUEUE), useValue: fila },
      ],
    }).compile();
    service = module.get(SorteLojaService);
  });

  it('debita, baixa o estoque, cria o pedido, a notificação do painel e enfileira o e-mail', async () => {
    const r = await comprar(FURADEIRA);

    expect(r.saldo).toBe(180);
    expect(r.pedido).toMatchObject({
      origem: 'LOJA',
      rodada: null,
      instrucoesRetirada: 'Retire na sede com o código.',
      situacao: 'AGUARDANDO_CONTATO',
    });
    expect(r.pedido.codigo).toMatch(/^[A-Z2-9]{6}$/);
    expect(tx.saldo(7)).toBe(180);
    expect(tx.premios.get(FURADEIRA)!.estoque).toBe(4);
    expect(tx.ganhadores).toEqual([
      expect.objectContaining({
        rodadaId: null,
        premioId: FURADEIRA,
        origem: 'LOJA',
        creditosGastos: 120,
      }),
    ]);
    expect(tx.movimentos).toEqual([
      expect.objectContaining({
        tipo: 'SAIDA_GANHADOR',
        quantidade: -1,
        estoqueApos: 4,
      }),
    ]);
    expect(tx.lancamentos).toEqual([
      expect.objectContaining({
        tipo: 'COMPRA_LOJA',
        valor: -120,
        saldoApos: 180,
      }),
    ]);
    expect(tx.notificacoesAdmin).toEqual([
      expect.objectContaining({
        tipo: 'NOVA_RETIRADA',
        ganhadorId: tx.ganhadores[0].id,
        premioId: FURADEIRA,
        emailDestinatarios: 'marketing@teste.com.br, outro@teste.com.br',
      }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fila.add).toHaveBeenCalledWith(
      SORTE_EMAIL_RETIRADA_JOB,
      { notificacaoId: tx.notificacoesAdmin[0].id },
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('estoque 1 com duas compras simultâneas: uma sucede, a outra recebe ESGOTADO', async () => {
    const codigos = await Promise.all([
      codigo(comprar(GARRAFA, 7)),
      codigo(comprar(GARRAFA, 8)),
    ]);
    expect(codigos.sort()).toEqual(['ESGOTADO', 'OK']);
    expect(tx.premios.get(GARRAFA)!.estoque).toBe(0);
    expect(tx.ganhadores).toHaveLength(1);
    expect(tx.lancamentos).toHaveLength(1);
    expect(tx.saldo(7) + tx.saldo(8)).toBe(540);
    // Esgotou: avisa a equipe também.
    expect(tx.notificacoesAdmin.map((n) => n.tipo).sort()).toEqual([
      'ESTOQUE_ESGOTADO',
      'NOVA_RETIRADA',
    ]);
    expect(tentativas.registrarErro).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'COMPRAR',
        contexto: { premioId: GARRAFA },
      }),
    );
  });

  it('dez compras simultâneas com estoque 5 não vendem além do estoque nem do limite', async () => {
    tx.premios.get(FURADEIRA)!.limitePorAssociado = 0;
    for (let u = 20; u < 30; u++) tx.comCarteira(u, 500);
    const codigos = await Promise.all(
      Array.from({ length: 10 }, (_, i) => codigo(comprar(FURADEIRA, 20 + i))),
    );
    expect(codigos.filter((c) => c === 'OK')).toHaveLength(5);
    expect(codigos.filter((c) => c === 'ESGOTADO')).toHaveLength(5);
    expect(tx.premios.get(FURADEIRA)!.estoque).toBe(0);
  });

  it('limite por associado: a segunda compra recebe LIMITE_POR_ASSOCIADO', async () => {
    await comprar(FURADEIRA);
    await expect(codigo(comprar(FURADEIRA))).resolves.toBe(
      'LIMITE_POR_ASSOCIADO',
    );
    expect(tx.saldo(7)).toBe(180);
    expect(tx.premios.get(FURADEIRA)!.estoque).toBe(4);
  });

  it('pedido cancelado não conta para o limite', async () => {
    await comprar(FURADEIRA);
    tx.ganhadores[0].situacao = 'CANCELADO';
    await expect(codigo(comprar(FURADEIRA))).resolves.toBe('OK');
  });

  it('saldo insuficiente: CREDITOS_INSUFICIENTES e nada muda', async () => {
    const erro = await comprar(FURADEIRA, 9).catch(
      (e: { getResponse: () => unknown }) => e.getResponse(),
    );
    expect(erro).toMatchObject({
      code: 'CREDITOS_INSUFICIENTES',
      saldo: 50,
      necessario: 120,
    });
    expect(tx.saldo(9)).toBe(50);
    expect(tx.premios.get(FURADEIRA)!.estoque).toBe(5);
    expect(tx.ganhadores).toHaveLength(0);
    expect(tx.notificacoesAdmin).toHaveLength(0);
  });

  it('produto fora da loja: 404', async () => {
    tx.premios.get(GARRAFA)!.naLoja = false;
    await expect(comprar(GARRAFA)).rejects.toThrow('Produto não encontrado');
  });
});

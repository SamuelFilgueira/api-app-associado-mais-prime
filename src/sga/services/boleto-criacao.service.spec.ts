import { resetTenantConfigCache } from 'src/config/tenant.config';
import { PrismaService } from 'src/database/prisma.service';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import {
  BoletoCadastradoSemRegistroError,
  BoletoReativacaoDefinitivoError,
  BoletoReativacaoInstabilidadeError,
} from 'src/sga/errors/boleto-reativacao.error';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { BoletoCriacaoService } from 'src/sga/services/boleto-criacao.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';

/**
 * Cadastro do boleto no SGA e o que vem depois dele: referência da
 * revistoria, gravação que alimenta a varredura, cache e avisos.
 */
describe('BoletoCriacaoService', () => {
  let prisma: {
    userVehicle: { findUnique: jest.Mock };
    reinspectionPayment: { upsert: jest.Mock; create: jest.Mock };
  };
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let hinova: {
    buscarAssociado: jest.Mock;
    invalidarAssociado: jest.Mock;
    invalidarBoletos: jest.Mock;
  };
  let suri: { enviarTemplate: jest.Mock };
  let service: BoletoCriacaoService;
  let chamadas: { url: string; data?: Record<string, unknown> }[];
  /** Resposta do `boleto/cadastrar` de cada teste. */
  let respostaDoCadastro: { status: number; data: unknown };

  beforeEach(() => {
    chamadas = [];
    respostaDoCadastro = {
      status: 200,
      data: [
        {
          nosso_numero: 123,
          link_boleto: 'https://boleto/123',
          linha_digitavel: '0001',
        },
      ],
    };
    prisma = {
      userVehicle: {
        findUnique: jest.fn().mockResolvedValue({
          user: { cpf: '529.982.247-25', baseOrigin: 'MAIS_PRIME' },
        }),
      },
      reinspectionPayment: {
        upsert: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    sgaAuth = {
      executeRequestWithAuth: jest.fn(
        (
          _base: string,
          req: { url: string; data?: Record<string, unknown> },
        ) => {
          chamadas.push({ url: req.url, data: req.data });
          if (req.url.includes('/produto-vinculado-veiculo/listar/')) {
            return Promise.resolve({
              status: 200,
              data: {
                valor_total_produtos_ativo_reais: 100,
                taxa_administrativa: '0',
                codigo_veiculo: 555,
              },
            });
          }
          if (req.url.endsWith('/boleto/cadastrar')) {
            return Promise.resolve(respostaDoCadastro);
          }
          return Promise.resolve({ status: 200, data: {} });
        },
      ),
    };
    hinova = {
      buscarAssociado: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          codigo_associado: 10,
          codigo_regional: 3,
          nome: 'Fulano de Tal',
          telefone_celular: '31999999999',
        },
      }),
      invalidarAssociado: jest.fn().mockResolvedValue(undefined),
      invalidarBoletos: jest.fn().mockResolvedValue(undefined),
    };
    suri = { enviarTemplate: jest.fn().mockResolvedValue(undefined) };
    service = new BoletoCriacaoService(
      new SgaBoletoClient(
        sgaAuth as unknown as SgaAuthService,
        hinova as unknown as HinovaClient,
      ),
      new PagamentoBoletoRepository(
        prisma as unknown as PrismaService,
        {} as OutboxService,
      ),
      suri as unknown as SuriNotificacaoService,
    );
  });

  const cadastros = () =>
    chamadas.filter((c) => c.url.endsWith('/boleto/cadastrar'));

  it('o boleto leva a referência da revistoria (REV-<id>) na descrição enviada ao SGA', async () => {
    await service.criarBoletoReativacao(1, 'ABC1D23', undefined, {
      reinspectionId: 42,
    });

    expect(cadastros()).toHaveLength(1);
    expect(cadastros()[0].data!.referencia).toEqual([
      expect.objectContaining({
        modulo: 'veiculo',
        codigo_modulo: '555',
        descricao: 'Boleto reativação app REV-42',
      }),
    ]);
  });

  it('usa a leitura com cache do associado (a mesma do app), não uma chamada própria', async () => {
    await service.criarBoletoReativacao(1, 'ABC1D23');

    expect(hinova.buscarAssociado).toHaveBeenCalledWith(
      'MAIS_PRIME',
      '52998224725',
    );
    expect(chamadas.some((c) => c.url.includes('/associado/buscar/'))).toBe(
      false,
    );
  });

  it('grava na linha o que o job repetível carregava e a primeira consulta para agora — sem criar job por boleto', async () => {
    const antes = Date.now();

    const criado = await service.criarBoletoReativacao(1, 'ABC1D23', 'dbg', {
      reinspectionId: 42,
    });

    const { create, update } = prisma.reinspectionPayment.upsert.mock
      .calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    for (const dados of [create, update]) {
      expect(dados).toMatchObject({
        baseOrigin: 'MAIS_PRIME',
        codigoVeiculo: '555',
        codigoAssociado: 10,
        nomeAssociado: 'Fulano de Tal',
        telefoneAssociado: '31999999999',
        verificacaoEncerradaEm: null,
        reinspectionId: 42,
      });
      expect(
        (dados.proximaConsultaEm as Date).getTime(),
      ).toBeGreaterThanOrEqual(antes);
    }
    expect(create).toMatchObject({ userVehicleId: 1, nossoNumero: '123' });
    expect(criado).toMatchObject({
      nossoNumero: '123',
      linkBoleto: 'https://boleto/123',
      pollerAgendado: true,
      suriEnviada: true,
      situacaoVeiculoAlterada: true,
    });
  });

  it('depois de gerar: invalida o cache dos boletos do veículo e do associado', async () => {
    await service.criarBoletoReativacao(1, 'ABC1D23');

    expect(hinova.invalidarAssociado).toHaveBeenCalledWith(
      'MAIS_PRIME',
      '52998224725',
    );
    expect(hinova.invalidarBoletos).toHaveBeenCalledWith(
      'MAIS_PRIME',
      expect.objectContaining({ codigo_veiculo: 555 }),
    );
  });

  it('gravação local falha: o erro carrega o boleto cadastrado; sem situação 20, sem WhatsApp', async () => {
    prisma.reinspectionPayment.upsert.mockRejectedValue(
      Object.assign(new Error('pool esgotado'), { code: 'P2024' }),
    );

    const erro: unknown = await service
      .criarBoletoReativacao(1, 'ABC1D23', undefined, { reinspectionId: 42 })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(erro).toBeInstanceOf(BoletoCadastradoSemRegistroError);
    expect((erro as BoletoCadastradoSemRegistroError).boleto).toEqual({
      nossoNumero: '123',
      linhaDigitavel: '0001',
      linkBoleto: 'https://boleto/123',
    });
    expect(
      chamadas.some((c) => c.url.includes('/veiculo/alterar-situacao-para/')),
    ).toBe(false);
    expect(suri.enviarTemplate).not.toHaveBeenCalled();
  });

  it('`registrarPagamentoBoleto` lança quando a gravação falha (antes só logava)', async () => {
    prisma.reinspectionPayment.upsert.mockRejectedValue(
      new Error('banco fora'),
    );

    await expect(
      service.registrarPagamentoBoleto({
        userVehicleId: 1,
        nossoNumero: '123',
        linhaDigitavel: null,
        linkBoleto: null,
      }),
    ).rejects.toThrow('banco fora');
  });

  it('regravar um boleto conhecido não apaga o link nem a linha digitável já gravados', async () => {
    await service.registrarPagamentoBoleto({
      userVehicleId: 1,
      nossoNumero: '123',
      linhaDigitavel: null,
      linkBoleto: null,
      baseOrigin: 'MAIS_PRIME',
      codigoVeiculo: '555',
    });

    const { update } = prisma.reinspectionPayment.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(update).not.toHaveProperty('linkBoleto');
    expect(update).not.toHaveProperty('linhaDigitavel');
    expect(update).toMatchObject({ situacaoBoleto: 'CRIADO', pago: false });
  });

  it('boleto sem código de veículo não entra na varredura (não há como verificar nem reativar)', async () => {
    await service.registrarPagamentoBoleto({
      userVehicleId: 1,
      nossoNumero: '123',
      linhaDigitavel: null,
      linkBoleto: null,
      baseOrigin: 'MAIS_PRIME',
      codigoVeiculo: null,
    });

    const { create } = prisma.reinspectionPayment.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
    };
    expect(create).not.toHaveProperty('proximaConsultaEm');
  });

  it('2xx do cadastro sem os dados do boleto: grava o registro sem número e avisa que não há verificação', async () => {
    respostaDoCadastro = { status: 200, data: { mensagem: 'ok' } };

    const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

    expect(prisma.reinspectionPayment.create).toHaveBeenCalledTimes(1);
    expect(prisma.reinspectionPayment.upsert).not.toHaveBeenCalled();
    expect(criado).toMatchObject({ nossoNumero: null, pollerAgendado: false });
  });

  it('SGA recusa a situação após o boleto: o boleto vale, e o resultado diz que a situação não mudou', async () => {
    const original = sgaAuth.executeRequestWithAuth.getMockImplementation()!;
    sgaAuth.executeRequestWithAuth.mockImplementation(
      (base: string, req: { url: string }) =>
        req.url.includes('/veiculo/alterar-situacao-para/')
          ? Promise.resolve({ status: 500, data: 'erro' })
          : original(base, req),
    );

    const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

    expect(criado).toMatchObject({
      nossoNumero: '123',
      situacaoVeiculoAlterada: false,
    });
  });

  it.each([
    [503, BoletoReativacaoInstabilidadeError],
    [403, BoletoReativacaoInstabilidadeError],
    [422, BoletoReativacaoDefinitivoError],
  ])(
    'boleto/cadastrar HTTP %i: erro tipado e nada gravado',
    async (status, tipo) => {
      respostaDoCadastro = { status, data: { mensagem: 'x' } };

      await expect(
        service.criarBoletoReativacao(1, 'ABC1D23'),
      ).rejects.toBeInstanceOf(tipo);
      expect(prisma.reinspectionPayment.upsert).not.toHaveBeenCalled();
      expect(hinova.invalidarBoletos).not.toHaveBeenCalled();
    },
  );

  it('falha do WhatsApp não desfaz o boleto: volta `suriEnviada = false`', async () => {
    suri.enviarTemplate.mockRejectedValue(new Error('ECONNRESET'));

    const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

    expect(criado).toMatchObject({ nossoNumero: '123', suriEnviada: false });
  });

  it('Mais Prime: sem encargos — não consulta boleto em aberto, valor base, nada a cancelar', async () => {
    const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

    expect(
      chamadas.some((c) => c.url.endsWith('/listar/boleto-associado-veiculo')),
    ).toBe(false);
    expect(cadastros()[0].data!.array_parcela).toEqual([
      expect.objectContaining({ valor: '100,00' }),
    ]);
    expect(criado).toMatchObject({ encargos: null, pendencia: null });
    const gravado = prisma.reinspectionPayment.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
    };
    expect(gravado.create).not.toHaveProperty('encargos');
  });

  /**
   * Regra da Hertz: multa de 2% (uma vez, sobre o valor base) + mora de 0,5%
   * ao dia, contando do vencimento do último boleto em aberto; o boleto em
   * aberto é cancelado (hoje: fica pendente de cancelamento manual, porque a
   * API do SGA não documenta essa rota).
   */
  describe('Hertz — encargos por atraso', () => {
    const basesOriginais = process.env.TENANT_BASES;
    /** Resposta da listagem de boletos em aberto, por chamada (janela). */
    let respostasDaListagem: { status: number; data: unknown }[];
    let encargosGravados: unknown;

    const boletoEmAberto = (extra: Record<string, unknown> = {}) => ({
      nosso_numero: 900,
      codigo_situacao_boleto: '2',
      codigo_tipo_boleto: '1',
      valor_boleto: '129.90',
      data_vencimento: '2026-11-10',
      data_vencimento_original: '2026-11-10',
      quantidade_dias_vencidos: 16,
      veiculos: [{ codigo_veiculo: 555 }],
      ...extra,
    });
    const listagens = () =>
      chamadas.filter((c) =>
        c.url.endsWith('/listar/boleto-associado-veiculo'),
      );
    const gravadoNoBanco = () =>
      (
        prisma.reinspectionPayment.upsert.mock.calls[0][0] as {
          create: { encargos?: Record<string, unknown> };
        }
      ).create.encargos;

    beforeEach(() => {
      process.env.TENANT_BASES = 'HERTZ';
      resetTenantConfigCache();
      // "Hoje" = 26/11/2026, 10h (o processo roda em America/Sao_Paulo).
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date(2026, 10, 26, 10, 0, 0));

      respostasDaListagem = [{ status: 200, data: [boletoEmAberto()] }];
      encargosGravados = null;
      prisma.userVehicle.findUnique.mockResolvedValue({
        user: { cpf: '529.982.247-25', baseOrigin: 'HERTZ' },
      });
      (
        prisma.reinspectionPayment as unknown as { findUnique: jest.Mock }
      ).findUnique = jest.fn(() =>
        Promise.resolve(
          encargosGravados ? { encargos: encargosGravados } : null,
        ),
      );
      sgaAuth.executeRequestWithAuth.mockImplementation(
        (
          _base: string,
          req: { url: string; data?: Record<string, unknown> },
        ) => {
          chamadas.push({ url: req.url, data: req.data });
          if (req.url.includes('/produto-vinculado-veiculo/listar/')) {
            return Promise.resolve({
              status: 200,
              data: {
                valor_total_produtos_ativo_reais: 120,
                taxa_administrativa: '9.90',
                codigo_veiculo: 555,
              },
            });
          }
          if (req.url.endsWith('/listar/boleto-associado-veiculo')) {
            return Promise.resolve(
              respostasDaListagem.shift() ?? { status: 404, data: null },
            );
          }
          if (req.url.endsWith('/boleto/cadastrar')) {
            return Promise.resolve(respostaDoCadastro);
          }
          return Promise.resolve({ status: 200, data: {} });
        },
      );
    });

    afterEach(() => {
      jest.useRealTimers();
      if (basesOriginais === undefined) delete process.env.TENANT_BASES;
      else process.env.TENANT_BASES = basesOriginais;
      resetTenantConfigCache();
    });

    it('boleto em aberto vencido há 16 dias: base 129,90 + multa 2,60 + mora 10,39 = 142,89', async () => {
      const criado = await service.criarBoletoReativacao(1, 'ABC1D23', 'dbg', {
        reinspectionId: 42,
      });

      // Uma consulta: só boletos EM ABERTO do veículo, vencidos nos últimos 90 dias.
      expect(listagens()).toHaveLength(1);
      expect(listagens()[0].data).toEqual({
        codigo_veiculo: 555,
        codigo_situacao_boleto: 2,
        data_vencimento_inicial: '29/08/2026',
        data_vencimento_final: '26/11/2026',
      });
      // O boleto novo sai com o valor total, na parcela e na referência.
      expect(cadastros()).toHaveLength(1);
      expect(cadastros()[0].data!.array_parcela).toEqual([
        { valor: '142,89', vencimento: '27/11/2026' },
      ]);
      expect(cadastros()[0].data!.referencia).toEqual([
        expect.objectContaining({
          valor: '142,89',
          descricao: 'Boleto reativação app REV-42',
        }),
      ]);
      // A memória de cálculo fica gravada com o boleto.
      expect(gravadoNoBanco()).toEqual({
        regra: { multaPercentual: 2, moraDiariaPercentual: 0.5 },
        valorBase: '129.90',
        multa: '2.60',
        mora: '10.39',
        valorTotal: '142.89',
        diasDeAtraso: 16,
        vencimentoDeReferencia: '2026-11-10',
        boletoAnterior: {
          nossoNumero: '900',
          vencimento: '2026-11-10',
          valor: '129.90',
          codigoTipoBoleto: '1',
        },
        cancelamento: {
          situacao: 'PENDENTE_MANUAL',
          motivo: expect.stringContaining('não documenta cancelamento'),
          em: new Date(2026, 10, 26, 10, 0, 0).toISOString(),
        },
      });
      expect(criado.nossoNumero).toBe('123');
      expect(criado.encargos).toMatchObject({ valorTotal: '142.89' });
    });

    it('o boleto em aberto não foi cancelado no SGA: a pendência diz à equipe qual boleto cancelar', async () => {
      const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

      expect(criado.pendencia).toBe(
        'Cancelar manualmente no SGA o boleto 900 (vencimento 10/11/2026): ele foi substituído pelo boleto de reativação 123, ' +
          'de R$ 142,89 (base R$ 129,90 + multa R$ 2,60 + mora R$ 10,39 por 16 dia(s) de atraso).',
      );
    });

    it('quando o SGA cancelar o boleto antigo, não sobra pendência', async () => {
      const client = (service as unknown as { client: SgaBoletoClient }).client;
      jest
        .spyOn(client, 'cancelarBoleto')
        .mockResolvedValue({ cancelado: true, motivo: null });

      const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

      expect(client.cancelarBoleto).toHaveBeenCalledWith('HERTZ', '900');
      expect(criado.pendencia).toBeNull();
      expect(gravadoNoBanco()!.cancelamento).toMatchObject({
        situacao: 'CANCELADO',
      });
    });

    it('falha ao cancelar não desfaz o boleto novo: vira pendência', async () => {
      const client = (service as unknown as { client: SgaBoletoClient }).client;
      jest
        .spyOn(client, 'cancelarBoleto')
        .mockRejectedValue(new Error('SGA fora'));

      const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

      expect(criado.nossoNumero).toBe('123');
      expect(criado.pendencia).toContain(
        'Cancelar manualmente no SGA o boleto 900',
      );
      expect(gravadoNoBanco()!.cancelamento).toMatchObject({
        situacao: 'PENDENTE_MANUAL',
        motivo: 'SGA fora',
      });
    });

    it('sem boleto em aberto (nenhuma das 4 janelas de 90 dias): valor base, sem multa nem mora, nada a cancelar', async () => {
      respostasDaListagem = [];

      const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

      expect(listagens()).toHaveLength(4);
      expect(listagens().map((c) => c.data!.data_vencimento_final)).toEqual([
        '26/11/2026',
        '28/08/2026',
        '30/05/2026',
        '01/03/2026',
      ]);
      expect(cadastros()[0].data!.array_parcela).toEqual([
        expect.objectContaining({ valor: '129,90' }),
      ]);
      expect(criado.pendencia).toBeNull();
      expect(gravadoNoBanco()).toMatchObject({
        valorTotal: '129.90',
        diasDeAtraso: 0,
        boletoAnterior: null,
        cancelamento: { situacao: 'NAO_APLICAVEL' },
      });
    });

    it('boleto em aberto mais antigo que 90 dias: é achado na janela anterior', async () => {
      respostasDaListagem = [
        { status: 404, data: { mensagem: 'Nenhum boleto encontrado' } },
        {
          status: 200,
          data: [boletoEmAberto({ data_vencimento: '2026-08-10' })],
        },
      ];

      await service.criarBoletoReativacao(1, 'ABC1D23');

      expect(listagens()).toHaveLength(2);
      expect(listagens()[1].data).toMatchObject({
        data_vencimento_inicial: '31/05/2026',
        data_vencimento_final: '28/08/2026',
      });
      // 10/08 → 26/11 = 108 dias: mora 129,90 × 0,5% × 108 = 70,15.
      expect(gravadoNoBanco()).toMatchObject({
        diasDeAtraso: 108,
        multa: '2.60',
        mora: '70.15',
        valorTotal: '202.65',
      });
    });

    it('boleto em aberto que já é um de reativação com encargos: o atraso conta da data de referência dele, não recomeça', async () => {
      // O boleto 900 foi gerado por esta API em 30/10 (vencimento 31/10),
      // substituindo uma mensalidade vencida em 10/10.
      respostasDaListagem = [
        {
          status: 200,
          data: [
            boletoEmAberto({
              codigo_tipo_boleto: '2',
              data_vencimento: '2026-10-31',
            }),
          ],
        },
      ];
      encargosGravados = { vencimentoDeReferencia: '2026-10-10' };

      await service.criarBoletoReativacao(1, 'ABC1D23');

      // 10/10 → 26/11 = 47 dias (e não os 26 desde 31/10).
      expect(gravadoNoBanco()).toMatchObject({
        diasDeAtraso: 47,
        vencimentoDeReferencia: '2026-10-10',
        mora: '30.53',
        valorTotal: '163.03',
        boletoAnterior: { nossoNumero: '900', vencimento: '2026-10-31' },
      });
    });

    it('SGA fora ao procurar o boleto em aberto: erro de instabilidade e NENHUM boleto é cadastrado', async () => {
      respostasDaListagem = [{ status: 503, data: { mensagem: 'fora' } }];

      await expect(
        service.criarBoletoReativacao(1, 'ABC1D23'),
      ).rejects.toBeInstanceOf(BoletoReativacaoInstabilidadeError);
      expect(cadastros()).toHaveLength(0);
      expect(prisma.reinspectionPayment.upsert).not.toHaveBeenCalled();
    });

    it('produtos do veículo sem codigo_veiculo: não há como achar o boleto em aberto — erro definitivo, sem cadastro', async () => {
      sgaAuth.executeRequestWithAuth.mockImplementation(
        (_base: string, req: { url: string }) => {
          chamadas.push({ url: req.url });
          return Promise.resolve({
            status: 200,
            data: req.url.includes('/produto-vinculado-veiculo/listar/')
              ? {
                  valor_total_produtos_ativo_reais: 120,
                  taxa_administrativa: '0',
                }
              : {},
          });
        },
      );

      await expect(
        service.criarBoletoReativacao(1, 'ABC1D23'),
      ).rejects.toBeInstanceOf(BoletoReativacaoDefinitivoError);
      expect(cadastros()).toHaveLength(0);
    });
  });
});

import { NotFoundException } from '@nestjs/common';
import { resetTenantConfigCache } from 'src/config/tenant.config';
import { PrismaService } from 'src/database/prisma.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { OutboxService } from 'src/infra/outbox/outbox.service';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { AssociadoSincronizacaoService } from 'src/sga/services/associado-sincronizacao.service';
import { BoletoCriacaoService } from 'src/sga/services/boleto-criacao.service';
import { SgaBoletoClient } from 'src/sga/services/sga-boleto.client';
import { SgaConsultaService } from 'src/sga/services/sga-consulta.service';
import { SgaVeiculoInfoService } from 'src/sga/services/sga-veiculo-info.service';
import { SgaService } from 'src/sga/services/sga.service';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';
import { VeiculosSincronizacaoService } from 'src/sga/services/veiculos-sincronizacao.service';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';

/**
 * Caracterização das consultas ao associado: a resposta ao app não muda e a
 * sincronização do cadastro só dispara quando o SGA devolve um associado.
 */
describe('SgaService', () => {
  let service: SgaService;
  /** Dono dos métodos de boleto que o `SgaService` só repassa. */
  let boletoCriacao: BoletoCriacaoService;
  let cache: { obter: jest.Mock; invalidar: jest.Mock };
  let prisma: {
    user: { findUnique: jest.Mock; findFirst: jest.Mock };
    userVehicle: {
      upsert: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
    };
  };
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let sincronizacao: { sincronizarEmSegundoPlano: jest.Mock };

  const usuarioDb = {
    id: 42,
    cpf: '529.982.247-25',
    baseOrigin: 'MAIS_PRIME_RS',
    name: 'Fulano de Tal',
    email: 'fulano@email.com',
    cep: '30130-010',
    address: 'Rua das Flores 123 Centro Belo Horizonte',
  };

  const associadoSga = {
    cpf: '52998224725',
    nome: 'Fulano de Tal',
    email: 'novo@email.com',
    descricao_situacao: 'ATIVO',
    veiculos: [{ chassi: '9BWZZZ377VT004251', placa: 'ABC1D23' }],
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(usuarioDb),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      userVehicle: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    sincronizacao = { sincronizarEmSegundoPlano: jest.fn() };

    // Cache "transparente": toda leitura vai à origem, como antes do cache.
    cache = {
      obter: jest.fn(async (opcoes: { carregar: () => Promise<unknown> }) => ({
        valor: await opcoes.carregar(),
        fonte: 'origem',
        atualizadoEm: new Date(),
      })),
      invalidar: jest.fn().mockResolvedValue(undefined),
    };
    const hinova = new HinovaClient(
      sgaAuth as unknown as SgaAuthService,
      cache as unknown as CacheService,
    );
    const boletoClient = new SgaBoletoClient(
      sgaAuth as unknown as SgaAuthService,
      hinova,
    );
    boletoCriacao = new BoletoCriacaoService(
      boletoClient,
      new PagamentoBoletoRepository(
        prisma as unknown as PrismaService,
        {} as OutboxService,
      ),
      {} as unknown as SuriNotificacaoService,
    );
    const veiculosSincronizacao = new VeiculosSincronizacaoService(
      prisma as unknown as PrismaService,
    );
    service = new SgaService(
      new SgaConsultaService(
        prisma as unknown as PrismaService,
        hinova,
        sincronizacao as unknown as AssociadoSincronizacaoService,
        veiculosSincronizacao,
      ),
      new SgaVeiculoInfoService(
        prisma as unknown as PrismaService,
        sgaAuth as unknown as SgaAuthService,
        veiculosSincronizacao,
      ),
      boletoCriacao,
      boletoClient,
    );
  });

  describe('consultarAssociado', () => {
    it('devolve o corpo do SGA e dispara a sincronização com o usuário lido', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: associadoSga,
      });

      const resultado = await service.consultarAssociado(42);

      expect(resultado).toEqual(associadoSga);
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledTimes(1);
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledWith(
        expect.objectContaining({ id: 42, cpf: '52998224725' }),
        associadoSga,
      );
    });

    it('omite veículos INATIVOS no SGA sem alterar o restante do corpo', async () => {
      const inativo = {
        chassi: '9BWZZZ377VT004252',
        placa: 'DEF4G56',
        descricao_situacao: 'INATIVO',
      };
      const corpoSga = {
        ...associadoSga,
        veiculos: [...associadoSga.veiculos, inativo],
      };
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: corpoSga,
      });

      const resultado = await service.consultarAssociado(42);

      expect(resultado).toEqual(associadoSga);
      // O corpo original (compartilhado entre requisições em voo) não é mutado.
      expect(corpoSga.veiculos).toHaveLength(2);
      // A sincronização local continua recebendo o corpo bruto do SGA.
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledWith(
        expect.anything(),
        corpoSga,
      );
    });

    it('consulta o SGA com CPF limpo e com a base de origem do usuário', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: associadoSga,
      });

      await service.consultarAssociado(42);

      // Uma única leitura no banco: sem relookup por CPF para resolver a base.
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledWith(
        'MAIS_PRIME_RS',
        expect.objectContaining({
          url: expect.stringMatching(/\/associado\/buscar\/52998224725$/),
        }),
      );
    });

    it('não sincroniza quando o SGA responde 406', async () => {
      const corpo406 = {
        mensagem: 'Não aceitável',
        error: ['Associado não encontrado'],
      };
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 406,
        data: corpo406,
      });

      const resultado = await service.consultarAssociado(42);

      expect(resultado).toBe(corpo406);
      expect(sincronizacao.sincronizarEmSegundoPlano).not.toHaveBeenCalled();
    });

    it('não sincroniza em erro 4xx/5xx e mantém o corpo de erro atual', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 500,
        data: null,
        statusText: 'Internal Server Error',
      });

      const resultado = await service.consultarAssociado(42);

      expect(resultado).toEqual({
        mensagem: 'Erro desconhecido',
        error: ['Internal Server Error'],
      });
      expect(sincronizacao.sincronizarEmSegundoPlano).not.toHaveBeenCalled();
    });

    it('lança NotFound quando o usuário não existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.consultarAssociado(99)).rejects.toThrow(
        NotFoundException,
      );
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('consultarVeiculosAssociado', () => {
    it('mantém a resposta (só veículos) e também dispara a sincronização', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: associadoSga,
      });

      const resultado = await service.consultarVeiculosAssociado(42);

      expect(resultado).toEqual(
        associadoSga.veiculos.map((v) => ({
          ...v,
          revistoria_obrigatoria: false,
        })),
      );
      expect(prisma.userVehicle.upsert).toHaveBeenCalledTimes(1);
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledTimes(1);
      expect(sincronizacao.sincronizarEmSegundoPlano).toHaveBeenCalledWith(
        expect.objectContaining({ id: 42, cpf: '52998224725' }),
        associadoSga,
      );
    });

    it('não retorna nem persiste como ativo veículo INATIVO no SGA', async () => {
      const ativo = {
        chassi: '9BWZZZ377VT004251',
        placa: 'ABC1D23',
        descricao_situacao: 'ATIVO',
      };
      const inativoPorDescricao = {
        chassi: '9BWZZZ377VT004252',
        placa: 'DEF4G56',
        descricao_situacao: 'Inativo ',
      };
      const inativoPorSituacao = {
        chassi: '9BWZZZ377VT004253',
        placa: 'GHI7J89',
        situacao: 'INATIVO',
      };
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: {
          ...associadoSga,
          veiculos: [ativo, inativoPorDescricao, inativoPorSituacao],
        },
      });

      const resultado = await service.consultarVeiculosAssociado(42);

      expect(resultado).toEqual([{ ...ativo, revistoria_obrigatoria: false }]);
      expect(prisma.userVehicle.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.userVehicle.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            chassi: { notIn: [ativo.chassi] },
          }),
        }),
      );
    });

    it('marca revistoria_obrigatoria pela regra da base (Mais Prime: só INADIMPLENTE 20 DIAS)', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: {
          ...associadoSga,
          veiculos: [
            { chassi: 'C1', descricao_situacao: 'INADIMPLENTE 20 DIAS' },
            { chassi: 'C2', descricao_situacao: 'INADIMPLENTE' },
            { chassi: 'C3', situacao: 'ATIVO' },
          ],
        },
      });

      const resultado = (await service.consultarVeiculosAssociado(42)) as {
        chassi: string;
        revistoria_obrigatoria: boolean;
      }[];

      expect(
        resultado.map((v) => [v.chassi, v.revistoria_obrigatoria]),
      ).toEqual([
        ['C1', true],
        ['C2', false],
        ['C3', false],
      ]);
    });

    it('não sincroniza quando o SGA responde erro', async () => {
      const corpoErro = { mensagem: 'Não aceitável' };
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 406,
        data: corpoErro,
      });

      const resultado = await service.consultarVeiculosAssociado(42);

      expect(resultado).toBe(corpoErro);
      expect(sincronizacao.sincronizarEmSegundoPlano).not.toHaveBeenCalled();
      expect(prisma.userVehicle.upsert).not.toHaveBeenCalled();
    });
  });
  describe('consultarVeiculosAssociado — resposta 2xx inesperada', () => {
    it.each([
      ['corpo de erro sem `veiculos`', { mensagem: 'Erro', error: ['falha'] }],
      ['página HTML do proxy', '<html>502 Bad Gateway</html>'],
      ['corpo vazio', null],
      ['`veiculos` que não é lista', { veiculos: 'indisponivel' }],
    ])(
      '%s: não desativa nenhum veículo nem sincroniza o cadastro',
      async (_caso, corpo) => {
        sgaAuth.executeRequestWithAuth.mockResolvedValue({
          status: 200,
          data: corpo,
        });

        const resultado = await service.consultarVeiculosAssociado(42);

        expect(resultado).toEqual([]);
        expect(prisma.userVehicle.updateMany).not.toHaveBeenCalled();
        expect(prisma.userVehicle.upsert).not.toHaveBeenCalled();
        expect(sincronizacao.sincronizarEmSegundoPlano).not.toHaveBeenCalled();
      },
    );

    it('lista vazia de verdade (associado sem veículos) segue desativando os locais', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: { ...associadoSga, veiculos: [] },
      });

      await service.consultarVeiculosAssociado(42);

      expect(prisma.userVehicle.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('criarBoletoReativacao — códigos do SGA pela regra da base', () => {
    const tenantBasesOriginal = process.env.TENANT_BASES;

    afterEach(() => {
      if (tenantBasesOriginal === undefined) delete process.env.TENANT_BASES;
      else process.env.TENANT_BASES = tenantBasesOriginal;
      resetTenantConfigCache();
    });

    /** Responde o SGA por rota e devolve o payload enviado ao boleto/cadastrar. */
    function prepararSga() {
      const chamadas: { url: string; data?: unknown }[] = [];
      sgaAuth.executeRequestWithAuth.mockImplementation(
        (_base: string, req: { url: string; data?: unknown }) => {
          chamadas.push({ url: req.url, data: req.data });
          if (req.url.includes('/associado/buscar/')) {
            return Promise.resolve({
              status: 200,
              data: { codigo_associado: 10, codigo_regional: 3 },
            });
          }
          if (req.url.includes('/produto-vinculado-veiculo/listar/')) {
            return Promise.resolve({
              status: 200,
              data: {
                valor_total_produtos_ativo_reais: 100,
                taxa_administrativa: '-10.50',
                codigo_veiculo: 555,
              },
            });
          }
          if (req.url.includes('/boleto/cadastrar')) {
            return Promise.resolve({
              status: 200,
              data: [{ nosso_numero: 123, link_boleto: 'https://boleto' }],
            });
          }
          return Promise.resolve({ status: 200, data: {} });
        },
      );
      jest
        .spyOn(boletoCriacao, 'registrarPagamentoBoleto')
        .mockResolvedValue(undefined as never);
      jest
        .spyOn(boletoCriacao, 'concluirBoletoReativacao')
        .mockResolvedValue({ pollerAgendado: true, suriEnviada: true });
      return chamadas;
    }

    const payloadCadastro = (chamadas: { url: string; data?: unknown }[]) =>
      chamadas.find((c) => c.url.endsWith('/boleto/cadastrar'))?.data as Record<
        string,
        unknown
      >;
    const alteracoesSituacao = (chamadas: { url: string }[]) =>
      chamadas
        .map((c) => c.url)
        .filter((url) => url.includes('/veiculo/alterar-situacao-para/'));

    it.each(['MAIS_PRIME', 'MAIS_PRIME_RS'])(
      '%s: conta 27, tipo 2 e veículo para a situação 20 (regra vigente)',
      async (base) => {
        prisma.userVehicle.findUnique.mockResolvedValue({
          user: { cpf: '529.982.247-25', baseOrigin: base },
        });
        const chamadas = prepararSga();

        await service.criarBoletoReativacao(1, 'ABC1D23');

        expect(payloadCadastro(chamadas)).toEqual(
          expect.objectContaining({
            codigo_conta: 27,
            codigo_tipo_boleto: 2,
            codigo_situacao: '2',
            codigo_associado: 10,
            codigo_regional: 3,
          }),
        );
        expect(alteracoesSituacao(chamadas)).toEqual([
          expect.stringMatching(/\/veiculo\/alterar-situacao-para\/20\/555$/),
        ]);
      },
    );

    it('HERTZ: conta 2, tipo 2 e não altera a situação do veículo', async () => {
      // Como na VPS da Hertz: a base do associado é uma das bases do deploy.
      process.env.TENANT_BASES = 'HERTZ';
      resetTenantConfigCache();
      prisma.userVehicle.findUnique.mockResolvedValue({
        user: { cpf: '529.982.247-25', baseOrigin: 'HERTZ' },
      });
      const chamadas = prepararSga();

      const criado = await service.criarBoletoReativacao(1, 'ABC1D23');

      expect(payloadCadastro(chamadas)).toEqual(
        expect.objectContaining({ codigo_conta: 2, codigo_tipo_boleto: 2 }),
      );
      expect(alteracoesSituacao(chamadas)).toEqual([]);
      expect(criado.nossoNumero).toBe('123');
    });
  });

  /**
   * Sem base válida a consulta falha (`BaseNaoResolvidaError`) antes de
   * falar com o SGA. Antes caía em silêncio na base padrão do deploy e a
   * operação seguia com a credencial de outra base.
   */
  describe('base não resolvida — sem fallback para a base padrão', () => {
    const semBase = { ...usuarioDb, baseOrigin: null };

    it('consultarAssociado: usuário sem base → BaseNaoResolvidaError e nenhuma chamada ao SGA', async () => {
      prisma.user.findUnique.mockResolvedValue(semBase);

      await expect(service.consultarAssociado(42)).rejects.toBeInstanceOf(
        BaseNaoResolvidaError,
      );
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(sincronizacao.sincronizarEmSegundoPlano).not.toHaveBeenCalled();
    });

    it('consultarAssociado: sem base no usuário lido, vale a do relookup por CPF (lógica mantida)', async () => {
      prisma.user.findUnique.mockResolvedValue(semBase);
      prisma.user.findFirst.mockResolvedValue({ baseOrigin: 'MAIS_PRIME' });
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: associadoSga,
      });

      await service.consultarAssociado(42);

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { cpf: '52998224725' },
      });
      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledWith(
        'MAIS_PRIME',
        expect.anything(),
      );
    });

    it('consultarAssociado: base do cadastro que não pertence ao deploy → BaseNaoResolvidaError', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...usuarioDb,
        baseOrigin: 'OUTRA_EMPRESA',
      });

      await expect(service.consultarAssociado(42)).rejects.toBeInstanceOf(
        BaseNaoResolvidaError,
      );
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    });

    it('consultarVeiculosAssociado: usuário sem base → BaseNaoResolvidaError, sem SGA e sem tocar os veículos locais', async () => {
      prisma.user.findUnique.mockResolvedValue(semBase);

      await expect(
        service.consultarVeiculosAssociado(42),
      ).rejects.toBeInstanceOf(BaseNaoResolvidaError);
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
      expect(prisma.userVehicle.upsert).not.toHaveBeenCalled();
      expect(prisma.userVehicle.updateMany).not.toHaveBeenCalled();
    });

    it('consultarVeiculoInfo: veículo sem dono no cadastro e token sem base → BaseNaoResolvidaError e nenhuma chamada ao SGA', async () => {
      prisma.userVehicle.findFirst.mockResolvedValue(null);

      await expect(
        service.consultarVeiculoInfo('9BWZZZ377VT004251', undefined),
      ).rejects.toBeInstanceOf(BaseNaoResolvidaError);
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    });

    it('consultarVeiculoInfo: veículo sem dono no cadastro usa a base do JWT', async () => {
      prisma.userVehicle.findFirst.mockResolvedValue(null);
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: { chassi: '9BWZZZ377VT004251', tipo: 'CARRO' },
      });

      await service.consultarVeiculoInfo('9BWZZZ377VT004251', 'MAIS_PRIME_RS');

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledWith(
        'MAIS_PRIME_RS',
        expect.objectContaining({
          url: expect.stringMatching(/\/veiculo\/buscar\/9BWZZZ377VT004251$/),
        }),
      );
    });

    it('consultarVeiculoInfo: a base do dono do veículo segue tendo prioridade (lógica mantida)', async () => {
      prisma.userVehicle.findFirst.mockResolvedValue({
        user: { baseOrigin: 'MAIS_PRIME' },
      });
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 200,
        data: [],
      });

      await service.consultarVeiculoInfo('9BWZZZ377VT004251', 'MAIS_PRIME_RS');

      expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledWith(
        'MAIS_PRIME',
        expect.anything(),
      );
    });

    it('criarBoletoReativacao: dono do veículo sem base → BaseNaoResolvidaError e nenhum boleto no SGA', async () => {
      prisma.userVehicle.findUnique.mockResolvedValue({
        user: { cpf: '529.982.247-25', baseOrigin: null },
      });

      await expect(
        service.criarBoletoReativacao(1, 'ABC1D23'),
      ).rejects.toBeInstanceOf(BaseNaoResolvidaError);
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    });
  });
});

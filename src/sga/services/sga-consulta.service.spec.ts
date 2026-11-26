import { PrismaService } from 'src/database/prisma.service';
import { registroDeMetricas } from 'src/infra/observability/metricas';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { AssociadoSincronizacaoService } from 'src/sga/services/associado-sincronizacao.service';
import { SgaConsultaService } from 'src/sga/services/sga-consulta.service';
import { SgaVeiculoInfoService } from 'src/sga/services/sga-veiculo-info.service';
import { VeiculosSincronizacaoService } from 'src/sga/services/veiculos-sincronizacao.service';

const erroComoSucesso = async (rota: string): Promise<number> => {
  const metrica = await registroDeMetricas
    .getSingleMetric('vendor_erro_como_sucesso_total')!
    .get();
  return metrica.values
    .filter((v) => v.labels.rota === rota && v.labels.vendor === 'hinova')
    .reduce((soma, v) => soma + v.value, 0);
};

/**
 * Consultas do app: leitura do associado pelo client com cache e contagem
 * dos pontos em que o erro do SGA volta ao app com HTTP 200.
 */
describe('SgaConsultaService e SgaVeiculoInfoService', () => {
  let prisma: {
    user: { findUnique: jest.Mock; findFirst: jest.Mock };
    userVehicle: {
      upsert: jest.Mock;
      updateMany: jest.Mock;
      findFirst: jest.Mock;
    };
  };
  let hinova: { buscarAssociado: jest.Mock };
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let sincronizacao: { sincronizarEmSegundoPlano: jest.Mock };
  let service: SgaConsultaService;
  let veiculoInfo: SgaVeiculoInfoService;

  const associadoSga = {
    cpf: '52998224725',
    nome: 'Fulano de Tal',
    veiculos: [{ chassi: '9BWZZZ377VT004251', placa: 'ABC1D23' }],
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 42,
          cpf: '529.982.247-25',
          baseOrigin: 'MAIS_PRIME',
          name: 'Fulano de Tal',
          email: 'f@e.com',
          cep: null,
          address: null,
        }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      userVehicle: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    hinova = {
      buscarAssociado: jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: associadoSga,
        fonte: 'cache',
        atualizadoEm: new Date(),
      }),
    };
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    sincronizacao = { sincronizarEmSegundoPlano: jest.fn() };
    const veiculosSincronizacao = new VeiculosSincronizacaoService(
      prisma as unknown as PrismaService,
    );
    service = new SgaConsultaService(
      prisma as unknown as PrismaService,
      hinova as unknown as HinovaClient,
      sincronizacao as unknown as AssociadoSincronizacaoService,
      veiculosSincronizacao,
    );
    veiculoInfo = new SgaVeiculoInfoService(
      prisma as unknown as PrismaService,
      sgaAuth as unknown as SgaAuthService,
      veiculosSincronizacao,
    );
  });

  describe('leitura do associado pelo client com cache', () => {
    it('`/sga/associado` e `/sga/veiculos` usam `HinovaClient.buscarAssociado`, sem chamada própria ao SGA', async () => {
      await service.consultarAssociado(42);
      await service.consultarVeiculosAssociado(42);

      expect(hinova.buscarAssociado).toHaveBeenCalledTimes(2);
      expect(hinova.buscarAssociado).toHaveBeenCalledWith(
        'MAIS_PRIME',
        '52998224725',
      );
      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    });

    it('resposta servida do cache tem o mesmo tratamento: devolve o corpo e sincroniza os veículos', async () => {
      await expect(service.consultarAssociado(42)).resolves.toEqual(
        associadoSga,
      );
      await expect(service.consultarVeiculosAssociado(42)).resolves.toEqual([
        { ...associadoSga.veiculos[0], revistoria_obrigatoria: false },
      ]);
      expect(prisma.userVehicle.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('erro do SGA devolvido ao app com HTTP 200 conta na métrica', () => {
    const corpoErro = { mensagem: 'Não aceitável', error: ['x'] };

    it.each([406, 404, 500])(
      '/sga/associado com HTTP %i do SGA: mesmo corpo de antes + contagem',
      async (status) => {
        hinova.buscarAssociado.mockResolvedValue({ status, data: corpoErro });
        const antes = await erroComoSucesso('sga/associado');

        await expect(service.consultarAssociado(42)).resolves.toBe(corpoErro);

        expect(await erroComoSucesso('sga/associado')).toBe(antes + 1);
      },
    );

    it('/sga/veiculos com erro do SGA: corpo de erro + contagem, sem tocar os veículos locais', async () => {
      hinova.buscarAssociado.mockResolvedValue({
        status: 503,
        data: corpoErro,
      });
      const antes = await erroComoSucesso('sga/veiculos');

      await expect(service.consultarVeiculosAssociado(42)).resolves.toBe(
        corpoErro,
      );

      expect(await erroComoSucesso('sga/veiculos')).toBe(antes + 1);
      expect(prisma.userVehicle.updateMany).not.toHaveBeenCalled();
    });

    it('/sga/veiculos com 2xx sem a lista de veículos: `[]` + contagem', async () => {
      hinova.buscarAssociado.mockResolvedValue({
        status: 200,
        data: '<html>502 Bad Gateway</html>',
      });
      const antes = await erroComoSucesso('sga/veiculos');

      await expect(service.consultarVeiculosAssociado(42)).resolves.toEqual([]);

      expect(await erroComoSucesso('sga/veiculos')).toBe(antes + 1);
    });

    it('/sga/veiculos-info com erro do SGA: corpo de erro + contagem', async () => {
      sgaAuth.executeRequestWithAuth.mockResolvedValue({
        status: 404,
        data: null,
        statusText: 'Not Found',
      });
      const antes = await erroComoSucesso('sga/veiculos-info');

      await expect(
        veiculoInfo.consultarVeiculoInfo('9BWZZZ377VT004251', 'MAIS_PRIME'),
      ).resolves.toEqual({
        mensagem: 'Erro desconhecido',
        error: ['Not Found'],
      });

      expect(await erroComoSucesso('sga/veiculos-info')).toBe(antes + 1);
    });

    it('resposta de sucesso não conta', async () => {
      const antes = await erroComoSucesso('sga/associado');

      await service.consultarAssociado(42);

      expect(await erroComoSucesso('sga/associado')).toBe(antes);
    });
  });

  it('setRevistoria: 404 quando nenhum veículo tem o chassi', async () => {
    prisma.userVehicle.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      veiculoInfo.setRevistoria('9BWZZZ377VT004251', true),
    ).rejects.toThrow('Veículo não encontrado para o chassi informado');
  });
});

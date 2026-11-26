import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { CacheService } from 'src/infra/cache/cache.service';
import { registroDeMetricas } from 'src/infra/observability/metricas';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BoletoService } from 'src/sga/boleto/services/boleto.service';
import { BaseNaoResolvidaError } from 'src/shared/tenant/tenant-context';

/**
 * A base da consulta de boletos vem do token ou do cadastro do dono do
 * veículo. Sem nenhuma das duas a consulta falha; nunca usa a base padrão.
 */
describe('BoletoService.consultarBoletosPorVeiculo (base da consulta)', () => {
  let prisma: { userVehicle: { findFirst: jest.Mock } };
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let service: BoletoService;

  beforeEach(() => {
    prisma = { userVehicle: { findFirst: jest.fn() } };
    sgaAuth = {
      executeRequestWithAuth: jest
        .fn()
        .mockResolvedValue({ status: 200, data: [] }),
    };
    // Cache "transparente": a leitura vai à Hinova, como antes do cache.
    const cache = {
      obter: async (opcoes: { carregar: () => Promise<unknown> }) => ({
        valor: await opcoes.carregar(),
        fonte: 'origem',
        atualizadoEm: new Date(),
      }),
    };
    service = new BoletoService(
      prisma as unknown as PrismaService,
      new HinovaClient(
        sgaAuth as unknown as SgaAuthService,
        cache as unknown as CacheService,
      ),
    );
  });

  it('veículo que não é do usuário → lista vazia, sem base e sem chamar a Hinova', async () => {
    prisma.userVehicle.findFirst.mockResolvedValue(null);

    await expect(
      service.consultarBoletosPorVeiculo(42, 987, undefined),
    ).resolves.toEqual([]);
    await expect(
      service.consultarBoletosPorVeiculo(42, 987, 'MAIS_PRIME'),
    ).resolves.toEqual([]);

    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
  });

  it('usa a base do token quando ela existe', async () => {
    prisma.userVehicle.findFirst.mockResolvedValue({
      user: { baseOrigin: 'MAIS_PRIME' },
    });

    await service.consultarBoletosPorVeiculo(42, 987, 'MAIS_PRIME_RS');

    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledWith(
      'MAIS_PRIME_RS',
      expect.objectContaining({
        url: expect.stringMatching(/\/listar\/boleto-associado-veiculo$/),
      }),
    );
  });

  it('token sem base → usa a base do cadastro do dono do veículo', async () => {
    prisma.userVehicle.findFirst.mockResolvedValue({
      user: { baseOrigin: 'MAIS_PRIME_RS' },
    });

    await service.consultarBoletosPorVeiculo(42, 987, undefined);

    expect(sgaAuth.executeRequestWithAuth).toHaveBeenCalledWith(
      'MAIS_PRIME_RS',
      expect.anything(),
    );
  });

  it.each([
    ['sem base', null],
    ['com base de outro deploy', 'OUTRA_EMPRESA'],
  ])(
    'token sem base e cadastro %s → BaseNaoResolvidaError e nenhuma chamada à Hinova',
    async (_caso, baseDoCadastro) => {
      prisma.userVehicle.findFirst.mockResolvedValue({
        user: { baseOrigin: baseDoCadastro },
      });

      await expect(
        service.consultarBoletosPorVeiculo(42, 987, undefined),
      ).rejects.toBeInstanceOf(BaseNaoResolvidaError);

      expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
    },
  );

  it('a lista vem pela leitura com cache da Hinova, com o filtro (e a chave) do veículo', async () => {
    const hinova = {
      listarBoletosDoVeiculo: jest.fn().mockResolvedValue({
        status: 200,
        data: [{ nosso_numero: 1, veiculos: [{ codigo_veiculo: 987 }] }],
      }),
    };
    const comCache = new BoletoService(
      prisma as unknown as PrismaService,
      hinova as unknown as HinovaClient,
    );
    prisma.userVehicle.findFirst.mockResolvedValue({
      user: { baseOrigin: 'MAIS_PRIME' },
    });

    const boletos = await comCache.consultarBoletosPorVeiculo(
      42,
      987,
      'MAIS_PRIME',
    );

    expect(hinova.listarBoletosDoVeiculo).toHaveBeenCalledWith(
      'MAIS_PRIME',
      expect.objectContaining({ codigo_veiculo: 987 }),
    );
    expect(boletos).toEqual([expect.objectContaining({ nosso_numero: 1 })]);
    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
  });

  it('erro do SGA volta dentro da lista (contrato legado) e conta em vendor_erro_como_sucesso_total', async () => {
    const valor = async () =>
      (
        await registroDeMetricas
          .getSingleMetric('vendor_erro_como_sucesso_total')!
          .get()
      ).values
        .filter((v) => v.labels.rota === 'sga/boleto/listar')
        .reduce((soma, v) => soma + v.value, 0);
    const antes = await valor();
    prisma.userVehicle.findFirst.mockResolvedValue({
      user: { baseOrigin: 'MAIS_PRIME' },
    });
    const corpoErro = { mensagem: 'Não aceitável', error: ['x'] };
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 406,
      data: corpoErro,
    });

    await expect(
      service.consultarBoletosPorVeiculo(42, 987, 'MAIS_PRIME'),
    ).resolves.toEqual([corpoErro]);

    expect(await valor()).toBe(antes + 1);
  });

  it('falha de banco segue respondendo 503 e nunca concede posse', async () => {
    prisma.userVehicle.findFirst.mockRejectedValue(new Error('banco fora'));

    await expect(
      service.consultarBoletosPorVeiculo(42, 987, 'MAIS_PRIME'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
  });
});

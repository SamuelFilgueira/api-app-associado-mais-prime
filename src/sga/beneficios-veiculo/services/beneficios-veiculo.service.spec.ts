import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { HinovaClient } from 'src/integrations/hinova/hinova.client';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';
import { BeneficiosVeiculoService } from 'src/sga/beneficios-veiculo/services/beneficios-veiculo.service';

describe('BeneficiosVeiculoService', () => {
  let sgaAuth: { executeRequestWithAuth: jest.Mock };
  let hinova: { listarProdutosDoVeiculo: jest.Mock };
  let service: BeneficiosVeiculoService;
  const corpo = { codigo_veiculo: '55', produtos: [] };

  beforeEach(() => {
    sgaAuth = { executeRequestWithAuth: jest.fn() };
    hinova = { listarProdutosDoVeiculo: jest.fn() };
    service = new BeneficiosVeiculoService(
      sgaAuth as unknown as SgaAuthService,
      hinova as unknown as HinovaClient,
    );
  });

  it('a consulta do app passa pelo cache do HinovaClient, com a base recebida', async () => {
    hinova.listarProdutosDoVeiculo.mockResolvedValue({
      status: 200,
      data: corpo,
    });

    await expect(
      service.getBeneficiosVeiculo('MAIS_PRIME_RS', ' 55 '),
    ).resolves.toBe(corpo);

    expect(hinova.listarProdutosDoVeiculo).toHaveBeenCalledWith(
      'MAIS_PRIME_RS',
      '55',
    );
    expect(sgaAuth.executeRequestWithAuth).not.toHaveBeenCalled();
  });

  it('a consulta "atual" (inscrição do Sorte) vai direto à Hinova', async () => {
    sgaAuth.executeRequestWithAuth.mockResolvedValue({
      status: 200,
      data: corpo,
    });

    await expect(
      service.getBeneficiosVeiculoAtual('MAIS_PRIME', '55'),
    ).resolves.toBe(corpo);

    expect(hinova.listarProdutosDoVeiculo).not.toHaveBeenCalled();
    expect(sgaAuth.executeRequestWithAuth.mock.calls[0][0]).toBe('MAIS_PRIME');
    expect(sgaAuth.executeRequestWithAuth.mock.calls[0][1].url).toContain(
      '/produto-vinculado-veiculo/listar/55',
    );
  });

  it('erro da Hinova mantém o 500 com a mensagem atual, nos dois caminhos', async () => {
    hinova.listarProdutosDoVeiculo.mockResolvedValue({ status: 403, data: {} });
    sgaAuth.executeRequestWithAuth.mockResolvedValue({ status: 500, data: {} });

    await expect(
      service.getBeneficiosVeiculo('MAIS_PRIME', '55'),
    ).rejects.toThrow(InternalServerErrorException);
    await expect(
      service.getBeneficiosVeiculoAtual('MAIS_PRIME', '55'),
    ).rejects.toThrow('Tente novamente mais tarde');
  });

  it('código do veículo vazio → 400, sem consultar nada', async () => {
    await expect(
      service.getBeneficiosVeiculo('MAIS_PRIME', '  '),
    ).rejects.toThrow(BadRequestException);
    expect(hinova.listarProdutosDoVeiculo).not.toHaveBeenCalled();
  });
});

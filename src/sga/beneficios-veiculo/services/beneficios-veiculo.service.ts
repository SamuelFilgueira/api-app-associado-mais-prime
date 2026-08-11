import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { SgaAuthService } from 'src/shared/sga-auth.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';

export interface Produto {
  codigo_produto: string;
  descricao: string;
  descricao_boleto: string;
  valor: string;
  codigo_classificacao_produto: string;
  exibir_mcv: string;
  exibir_boleto: string;
  formato_cobranca: string;
  situacao: string;
}

export interface BeneficiosResponse {
  codigo_veiculo: string;
  valor_fixo: number;
  codigo_cota: string;
  valor_fipe: number;
  valor_total_produtos_ativo_reais: number;
  valor_total_produtos_ativo_porcento: number;
  valor_total_produtos_RS: number;
  valor_total_produtos_: number;
  formato_cobranca_taxa_administrativa: string;
  taxa_administrativa: string;
  produtos: Produto[];
  produtos_adicionais: unknown[];
}

@Injectable()
export class BeneficiosVeiculoService {
  private readonly logger = new Logger(BeneficiosVeiculoService.name);

  constructor(private readonly sgaAuthService: SgaAuthService) {}

  async getBeneficiosVeiculo(
    baseOrigin: BaseOrigin,
    codigoVeiculo: string,
  ): Promise<BeneficiosResponse> {
    const normalizedCodigoVeiculo = codigoVeiculo?.trim();

    if (!normalizedCodigoVeiculo) {
      throw new BadRequestException('codigoVeiculo é obrigatório');
    }

    const baseUrl = `https://api.hinova.com.br/api/sga/v2/produto-vinculado-veiculo/listar/${normalizedCodigoVeiculo}`;

    try {
      const response = await this.sgaAuthService.executeRequestWithAuth<BeneficiosResponse>(baseOrigin, {
        method: 'GET',
        url: baseUrl,
        headers: {
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      });

      if (response.status >= 400) {
        this.logger.error(
          `Erro ao obter beneficios do veiculo ${normalizedCodigoVeiculo}: status=${response.status} body=${JSON.stringify(response.data)}`,
        );
        throw new InternalServerErrorException(
          'Nao foi possivel obter os beneficios do veiculo',
        );
      }

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data) {
        this.logger.error(
          `Erro externo ao obter beneficios do veiculo ${normalizedCodigoVeiculo}: ${JSON.stringify(error.response.data)}`,
        );
      }

      throw new InternalServerErrorException(
        'Nao foi possivel obter os beneficios do veiculo. Tente novamente mais tarde.',
      );
    }
  }
}

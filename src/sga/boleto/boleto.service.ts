import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { SgaAuthService } from 'src/shared/sga-auth.service';

function formatDateBR(date: Date) {
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  const ano = date.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

@Injectable()
export class BoletoService {
  private readonly logger = new Logger(BoletoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sgaAuthService: SgaAuthService,
  ) {}

  private async resolveBaseOriginByCodigoVeiculo(
    codigoVeiculo: number,
  ): Promise<BaseOrigin> {
    try {
      const userVehicle = await this.prisma.userVehicle.findFirst({
        where: { externalVehicleCode: String(codigoVeiculo) },
        select: { user: { select: { baseOrigin: true } } },
      });

      if (userVehicle?.user?.baseOrigin) {
        return userVehicle.user.baseOrigin as BaseOrigin;
      }
    } catch (error: any) {
      this.logger.warn(
        `Falha ao resolver baseOrigin por codigo_veiculo=${codigoVeiculo}: ${error?.message}`,
      );
    }

    return 'MAIS_PRIME';
  }

  async consultarBoletosPorVeiculo(codigo_veiculo: number) {
    const baseOrigin = await this.resolveBaseOriginByCodigoVeiculo(codigo_veiculo);
    const now = new Date();
    const dataInicial = new Date(now);
    dataInicial.setDate(now.getDate() - 45);
    const dataFinal = new Date(now);
    dataFinal.setDate(dataFinal.getDate() + 45);
    const dataInicialStr = formatDateBR(dataInicial);
    const dataFinalStr = formatDateBR(dataFinal);
    const body = {
      codigo_veiculo,
      //codigo_situacao_boleto: '2',
      data_vencimento_original_inicial: dataInicialStr,
      data_vencimento_original_final: dataFinalStr,
    };

    try {
      const response = await this.sgaAuthService.executeRequestWithAuth<any>(
        baseOrigin,
        {
          method: 'POST',
          url: 'https://api.hinova.com.br/api/sga/v2/listar/boleto-associado-veiculo',
          data: body,
          headers: {
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
        },
      );

      //his.logger.log(`Resposta da API de boletos para veículo ${codigo_veiculo}: status=${response.status} body=${JSON.stringify(response.data)}`);

      const boletos: Array<{
        nosso_numero?: any;
        linha_digitavel?: any;
        link_boleto?: any;
        valor_boleto?: any;
        situacao_boleto?: any;
        data_vencimento?: any;
        data_pagamento?: any;
        [key: string]: any;
      }> = [];
      if (response.status === 200 && Array.isArray(response.data)) {
        for (const boleto of response.data) {
          boletos.push({
            nosso_numero: boleto.nosso_numero,
            linha_digitavel: boleto.linha_digitavel,
            pix: boleto.pix?.copia_cola ?? null,
            link_boleto: boleto.link_boleto,
            valor_boleto: boleto.valor_boleto,
            situacao_boleto: boleto.situacao_boleto,
            data_vencimento: boleto.data_vencimento,
            data_pagamento: boleto.data_pagamento,
            placa:
              boleto.veiculos && boleto.veiculos[0]
                ? boleto.veiculos[0].placa
                : undefined,
          });
        }
      } else {
        boletos.push(response.data as any);
      }
      //this.logger.log(`Boletos processados para veículo ${codigo_veiculo}: ${JSON.stringify(boletos)}`);
      return boletos;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        return [error.response.data as any];
      }
      throw new InternalServerErrorException(
        'Erro ao consultar boletos na Hinova',
      );
    }
  }
}

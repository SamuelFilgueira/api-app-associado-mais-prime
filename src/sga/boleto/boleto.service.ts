import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma.service';

function formatDateBR(date: Date) {
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  const ano = date.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

@Injectable()
export class BoletoService {
  private readonly logger = new Logger(BoletoService.name);
  async consultarBoletosPorVeiculo(codigo_veiculo: number) {
    const now = new Date();
    const dataInicial = new Date(now);
    dataInicial.setDate(now.getDate() - 90);
    const dataFinal = new Date(now);
    dataFinal.setDate(dataFinal.getDate() + 30);
    dataFinal.setDate(now.getDate());
    const dataInicialStr = formatDateBR(dataInicial);
    const dataFinalStr = formatDateBR(dataFinal);
    const body = {
      codigo_veiculo,
      //codigo_situacao_boleto: '2',
      data_vencimento_original_inicial: dataInicialStr,
      data_vencimento_original_final: dataFinalStr,
    };
    this.logger.log(`Dados do corpo da requisição: ${JSON.stringify(body)}`);
    try {
      const response = await axios.post(
        'https://api.hinova.com.br/api/sga/v2/listar/boleto-associado-veiculo',
        body,
        {
          headers: {
            Authorization: `Bearer ${process.env.SGA_TOKEN}`,
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
        },
      );

      this.logger.log(`Dados retornados da API de boletos: ${JSON.stringify(response.data)}`);

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
        boletos.push(response.data);
      }
      return boletos;
    } catch (error) {
      if (error.response && error.response.data) {
        return [error.response.data];
      }
      throw new InternalServerErrorException(
        'Erro ao consultar boletos na Hinova',
      );
    }
  }
}

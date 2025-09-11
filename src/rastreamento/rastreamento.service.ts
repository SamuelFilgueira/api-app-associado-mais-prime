import { Injectable, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class RastreamentoService {
  private token: string | null = null;
  private tokenExpires: number | null = null;

  constructor() {
    // Renovar token a cada 30 minutos (1800000 ms)
    this.renovarToken(); // primeira renovação ao iniciar
    setInterval(() => {
      this.renovarToken().catch(() => {});
    }, 1800000);
  }

  async ultimaPosicao(cnpj: string, chassi: string) {
    if (!this.token) {
      throw new InternalServerErrorException('Token não disponível. Tente novamente em instantes.');
    }
    try {
      const response = await axios.post(
        'https://api.gps.tec.br/apiv3_homologacao/api/veiculos/ultima-posicao',
        { cnpj, chassi },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        }
      );
      // Se token inválido, renovar e tentar novamente uma vez
      if (response.status === 401 || (response.data && typeof response.data === 'object' && response.data.mensagem && response.data.mensagem.toLowerCase().includes('token'))) {
        await this.renovarToken();
        const retry = await axios.post(
          'https://api.gps.tec.br/apiv3_homologacao/api/veiculos/ultima-posicao',
          { cnpj, chassi },
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
            },
          }
        );
        return retry.data;
      }
      return response.data;
    } catch (error) {
      throw new InternalServerErrorException('Erro ao consultar última posição do veículo');
    }
  }

  async renovarToken() {
    try {
      const response = await axios.post('https://api.gps.tec.br/apiv3_homologacao/login', {
        codigo: '1',
        api_m7_token: process.env.MO7_TOKEN,
      });
      if (response.data && response.data.sucesso) {
        this.token = response.data.token;
        this.tokenExpires = response.data.expires_in;
        return {
          token: this.token,
          expires_in: this.tokenExpires,
          empresa: response.data.empresa,
        };
      }
      throw new InternalServerErrorException('Falha ao renovar token');
    } catch (error) {
      throw new InternalServerErrorException('Erro ao renovar token');
    }
  }
}

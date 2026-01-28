import { InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';

export interface UltimaPosicaoM7Response {
  monitorado: number;
  data_gps: string;
  latitude: string;
  longitude: string;
  velocidade: number;
  ignicao: boolean;
  cidade: string;
  marca: string;
  modelo: string;
  identificador: string;
}

export type AncoraM7Response =
  | {
      mensagem: string;
      monitorado: number;
      ancora_ativa: number;
      evt_ign: number;
      evg_ign_exec: number;
      ancora_lat: number;
      ancora_lng: number;
    }
  | {
      erro: string;
    };

export class RastreamentoM7 {
  private token: string | null = null;
  private tokenExpires: number | null = null;

  constructor() {
    // Renovar token a cada 30 minutos (1800000 ms) - M7
    void this.renovarToken(); // primeira renovação ao iniciar
    setInterval(() => {
      this.renovarToken().catch(() => {});
    }, 1800000);
  }

  // Consultar a última posição do veículo via M7
  async ultimaPosicaoM7(
    cnpj: string,
    chassi: string,
  ): Promise<UltimaPosicaoM7Response> {
    if (!this.token) {
      throw new InternalServerErrorException(
        'Token não disponível. Tente novamente em instantes.',
      );
    }
    try {
      const response = await axios.post(
        `${process.env.M7_API_BASE_URL_HOMOLOG}api/veiculos/ultima-posicao`,
        { cnpj, chassi },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        },
      );
      // Se token inválido, renovar e tentar novamente uma vez
      if (
        response.status === 401 ||
        (response.data &&
          typeof response.data === 'object' &&
          response.data.mensagem &&
          response.data.mensagem.toLowerCase().includes('token'))
      ) {
        await this.renovarToken();
        const retry = await axios.post(
          `${process.env.M7_API_BASE_URL_HOMOLOG}api/veiculos/ultima-posicao`,
          { cnpj, chassi },
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
            },
          },
        );
        return this.mapearUltimaPosicaoM7(retry.data);
      }
      return this.mapearUltimaPosicaoM7(response.data);
    } catch (error) {
      throw new InternalServerErrorException(
        'Erro ao consultar última posição do veículo',
      );
    }
  }

  async ancoraM7(
    cnpj: string,
    chassi: string,
    ancoraAtiva: boolean,
  ): Promise<AncoraM7Response> {
    if (!this.token) {
      throw new InternalServerErrorException(
        'Token não disponível. Tente novamente em instantes.',
      );
    }

    const payload = {
      cnpj,
      chassi,
      ancora_ativa: ancoraAtiva,
      evt_ign: true,
      Envio_mult: false,
    };

    try {
      const response = await axios.post(
        `${process.env.M7_API_BASE_URL_HOMOLOG}api/veiculos/ancora`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        },
      );

      if (
        response.status === 401 ||
        (response.data &&
          typeof response.data === 'object' &&
          response.data.mensagem &&
          response.data.mensagem.toLowerCase().includes('token'))
      ) {
        await this.renovarToken();
        const retry = await axios.post(
          `${process.env.M7_API_BASE_URL_HOMOLOG}api/veiculos/ancora`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
            },
          },
        );
        return this.mapearAncoraM7(retry.data);
      }

      return this.mapearAncoraM7(response.data);
    } catch (error) {
      throw new InternalServerErrorException('Erro ao atualizar âncora');
    }
  }

  private mapearUltimaPosicaoM7(data: any): UltimaPosicaoM7Response {
    const ultimaPosicao = data.ultima_posicao || {};

    return {
      monitorado: ultimaPosicao.monitorado,
      data_gps: ultimaPosicao.data_gps,
      latitude: ultimaPosicao.latitude,
      longitude: ultimaPosicao.longitude,
      velocidade: ultimaPosicao.velocidade,
      ignicao: ultimaPosicao.ignicao,
      cidade: ultimaPosicao.cidade,
      marca: ultimaPosicao.marca,
      modelo: ultimaPosicao.modelo,
      identificador: ultimaPosicao.identificador,
    };
  }

  private mapearAncoraM7(data: any): AncoraM7Response {
    if (data && typeof data === 'object' && 'erro' in data) {
      return { erro: (data as { erro: string }).erro };
    }

    const ancora = data || {};

    return {
      mensagem: ancora.mensagem,
      monitorado: ancora.monitorado,
      ancora_ativa: ancora.ancora_ativa,
      evt_ign: ancora.evt_ign,
      evg_ign_exec: ancora.evg_ign_exec,
      ancora_lat: ancora.ancora_lat,
      ancora_lng: ancora.ancora_lng,
    };
  }

  async renovarToken() {
    try {
      const response = await axios.post(
        `${process.env.M7_API_BASE_URL_HOMOLOG}login`,
        {
          //codigo: '208' código de produção,
          codigo: '1',
          api_m7_token: process.env.MO7_TOKEN_HOMOLOG,
        },
      );
      if (response.data && response.data.sucesso) {
        this.token = response.data.token;
        this.tokenExpires = response.data.expires_in;
        console.log('[M7] Token renovado com sucesso', this.token);
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

  async processarWebhook(payload: unknown): Promise<{
    sucesso: boolean;
    mensagem: string;
    dados?: unknown;
  }> {
    const timestamp = new Date().toISOString();

    try {
      // Log inicial do recebimento do webhook
      console.log(`[${timestamp}] [M7 Webhook] Webhook recebido`);
      console.log(`[${timestamp}] [M7 Webhook] Payload tipo:`, typeof payload);

      // Validação básica do payload
      if (!payload) {
        console.warn(
          `[${timestamp}] [M7 Webhook] Payload vazio ou nulo recebido`,
        );
        return {
          sucesso: false,
          mensagem: 'Payload vazio ou inválido',
        };
      }

      // Log do payload completo (útil para desenvolvimento/debugging)
      console.log(
        `[${timestamp}] [M7 Webhook] Payload recebido:`,
        JSON.stringify(payload, null, 2),
      );

      // Validação se é um objeto
      if (typeof payload !== 'object') {
        console.warn(
          `[${timestamp}] [M7 Webhook] Payload não é um objeto válido`,
        );
        return {
          sucesso: false,
          mensagem: 'Payload deve ser um objeto JSON válido',
        };
      }

      // Tipagem segura do payload
      const payloadData = payload as Record<string, unknown>;
      // Retorno de sucesso
      console.log(`[${timestamp}] [M7 Webhook] Webhook processado com sucesso`);
      return {
        sucesso: true,
        mensagem: 'Webhook processado com sucesso',
        dados: {
          palyload: payloadData,
          timestamp_recebimento: timestamp,
        },
      };
    } catch (error) {
      // Tratamento robusto de erros - não pausar a aplicação
      console.error(
        `[${timestamp}] [M7 Webhook] Erro ao processar webhook:`,
        error,
      );

      // Log detalhado do erro
      if (error instanceof Error) {
        console.error(`[${timestamp}] [M7 Webhook] Erro - Nome: ${error.name}`);
        console.error(
          `[${timestamp}] [M7 Webhook] Erro - Mensagem: ${error.message}`,
        );
        console.error(
          `[${timestamp}] [M7 Webhook] Erro - Stack: ${error.stack}`,
        );
      } else {
        console.error(`[${timestamp}] [M7 Webhook] Erro desconhecido:`, error);
      }

      // Log do payload que causou o erro
      console.error(
        `[${timestamp}] [M7 Webhook] Payload que causou erro:`,
        JSON.stringify(payload, null, 2),
      );

      // Retornar resposta de erro sem lançar exceção
      return {
        sucesso: false,
        mensagem: 'Erro ao processar webhook',
        dados: {
          erro: error instanceof Error ? error.message : 'Erro desconhecido',
          timestamp_erro: timestamp,
        },
      };
    }
  }
}

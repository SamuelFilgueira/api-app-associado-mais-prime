import { InternalServerErrorException, Logger } from '@nestjs/common';
import axios from 'axios';

/** Timeout padrão para chamadas HTTP à API M7 (em ms) */
const M7_REQUEST_TIMEOUT = 15_000;

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
  private readonly logger = new Logger(RastreamentoM7.name);
  private token: string | null = null;
  private tokenExpires: number | null = null;

  /** Mutex para evitar renovações de token simultâneas */
  private tokenRenewalPromise: Promise<void> | null = null;

  constructor() {
    // Renovar token a cada 30 minutos (1800000 ms) - M7
    void this.renovarToken(); // primeira renovação ao iniciar
    setInterval(() => {
      this.renovarToken().catch(() => {});
    }, 1800000).unref(); // unref para não bloquear shutdown
  }

  /**
   * Detecta se a resposta indica token expirado/inválido.
   */
  private isTokenError(response: {
    status: number;
    data: Record<string, unknown> | null;
  }): boolean {
    return (
      response.status === 401 ||
      (response.data !== null &&
        typeof response.data === 'object' &&
        typeof response.data.mensagem === 'string' &&
        response.data.mensagem.toLowerCase().includes('token'))
    );
  }

  /**
   * Wrapper genérico: executa request, e em caso de token inválido
   * renova e faz retry uma única vez.
   */
  private async executarComReautenticacao<T>(
    request: () => Promise<{ status: number; data: T }>,
  ): Promise<T> {
    const response = await request();

    if (
      this.isTokenError(
        response as { status: number; data: Record<string, unknown> | null },
      )
    ) {
      this.logger.warn('Token M7 expirado/inválido — renovando e retentando');
      await this.renovarToken();
      const retry = await request();
      return retry.data;
    }

    return response.data;
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
      const data = await this.executarComReautenticacao(() =>
        axios.post(
          `${process.env.M7_API_BASE_URL}api/veiculos/ultima-posicao`,
          { cnpj, chassi },
          {
            headers: { Authorization: `Bearer ${this.token}` },
            timeout: M7_REQUEST_TIMEOUT,
          },
        ),
      );
      return this.mapearUltimaPosicaoM7(data as Record<string, unknown>);
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `Erro ao consultar última posição M7: ${error instanceof Error ? error.message : error}`,
      );
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
      const data = await this.executarComReautenticacao(() =>
        axios.post(
          `${process.env.M7_API_BASE_URL}api/veiculos/ancora`,
          payload,
          {
            headers: { Authorization: `Bearer ${this.token}` },
            timeout: M7_REQUEST_TIMEOUT,
          },
        ),
      );
      return this.mapearAncoraM7(data as Record<string, unknown>);
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `Erro ao atualizar âncora M7: ${error instanceof Error ? error.message : error}`,
      );
      throw new InternalServerErrorException('Erro ao atualizar âncora');
    }
  }

  private mapearUltimaPosicaoM7(
    data: Record<string, unknown>,
  ): UltimaPosicaoM7Response {
    const ultimaPosicao = (data.ultima_posicao || {}) as Record<
      string,
      unknown
    >;

    return {
      monitorado: ultimaPosicao.monitorado as number,
      data_gps: ultimaPosicao.data_gps as string,
      latitude: ultimaPosicao.latitude as string,
      longitude: ultimaPosicao.longitude as string,
      velocidade: ultimaPosicao.velocidade as number,
      ignicao: ultimaPosicao.ignicao as boolean,
      cidade: ultimaPosicao.cidade as string,
      marca: ultimaPosicao.marca as string,
      modelo: ultimaPosicao.modelo as string,
      identificador: ultimaPosicao.identificador as string,
    };
  }

  private mapearAncoraM7(data: Record<string, unknown>): AncoraM7Response {
    if (data && typeof data === 'object' && 'erro' in data) {
      return { erro: (data as { erro: string }).erro };
    }

    const ancora = data;

    return {
      mensagem: ancora.mensagem as string,
      monitorado: ancora.monitorado as number,
      ancora_ativa: ancora.ancora_ativa as number,
      evt_ign: ancora.evt_ign as number,
      evg_ign_exec: ancora.evg_ign_exec as number,
      ancora_lat: ancora.ancora_lat as number,
      ancora_lng: ancora.ancora_lng as number,
    };
  }

  /**
   * Renova o token M7 com mutex — chamadas concorrentes reutilizam
   * a mesma promise de renovação, evitando múltiplos logins simultâneos.
   */
  async renovarToken() {
    if (this.tokenRenewalPromise) {
      await this.tokenRenewalPromise;
      return {
        token: this.token,
        expires_in: this.tokenExpires,
      };
    }

    this.tokenRenewalPromise = this.executeRenovarToken();

    try {
      await this.tokenRenewalPromise;
      return {
        token: this.token,
        expires_in: this.tokenExpires,
      };
    } finally {
      this.tokenRenewalPromise = null;
    }
  }

  private async executeRenovarToken(): Promise<void> {
    try {
      const response = await axios.post(
        `${process.env.M7_API_BASE_URL}login`,
        {
          codigo: '208', //código de produção
          api_m7_token: process.env.MO7_TOKEN,
        },
        { timeout: M7_REQUEST_TIMEOUT },
      );
      if (response.data && response.data.sucesso) {
        this.token = response.data.token;
        this.tokenExpires = response.data.expires_in;
        this.logger.log('Token M7 renovado com sucesso');
        return;
      }
      throw new InternalServerErrorException('Falha ao renovar token');
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `Erro ao renovar token M7: ${error instanceof Error ? error.message : error}`,
      );
      throw new InternalServerErrorException('Erro ao renovar token');
    }
  }

  processarWebhook(payload: unknown): {
    sucesso: boolean;
    mensagem: string;
    dados?: unknown;
  } {
    const timestamp = new Date().toISOString();

    try {
      // Log inicial do recebimento do webhook
      this.logger.log(`[M7 Webhook] Webhook recebido`);
      this.logger.debug(`[M7 Webhook] Payload tipo: ${typeof payload}`);

      // Validão básica do payload
      if (!payload) {
        this.logger.warn('[M7 Webhook] Payload vazio ou nulo recebido');
        return {
          sucesso: false,
          mensagem: 'Payload vazio ou inválido',
        };
      }

      // Log do payload completo (útil para desenvolvimento/debugging)
      this.logger.debug(
        `[M7 Webhook] Payload recebido: ${JSON.stringify(payload, null, 2)}`,
      );

      // Validação se é um objeto
      if (typeof payload !== 'object') {
        this.logger.warn('[M7 Webhook] Payload não é um objeto válido');
        return {
          sucesso: false,
          mensagem: 'Payload deve ser um objeto JSON válido',
        };
      }

      // Tipagem segura do payload
      const payloadData = payload as Record<string, unknown>;
      // Retorno de sucesso
      this.logger.log('[M7 Webhook] Webhook processado com sucesso');
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
      this.logger.error('[M7 Webhook] Erro ao processar webhook:', error);

      // Log detalhado do erro
      if (error instanceof Error) {
        this.logger.error(`[M7 Webhook] Erro - Nome: ${error.name}`);
        this.logger.error(`[M7 Webhook] Erro - Mensagem: ${error.message}`);
        this.logger.error(`[M7 Webhook] Erro - Stack: ${error.stack}`);
      } else {
        this.logger.error('[M7 Webhook] Erro desconhecido:', error);
      }

      // Log do payload que causou o erro
      this.logger.error(
        `[M7 Webhook] Payload que causou erro: ${JSON.stringify(payload, null, 2)}`,
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

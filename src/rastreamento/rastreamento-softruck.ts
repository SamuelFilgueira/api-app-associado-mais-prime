import { InternalServerErrorException, Logger } from '@nestjs/common';
import axios from 'axios';

/** Timeout padrão para chamadas HTTP à API Softruck (em ms) */
const SOFTRUCK_REQUEST_TIMEOUT = 15_000;

/** TTL do cache de vehicle/device em ms (10 minutos) */
const CACHE_TTL = 10 * 60 * 1000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export interface UltimaPosicaoSoftruckResponse {
  date: string;
  ign?: boolean;
  speed: number;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  plate: string;
  brandName: string;
  modelName: string;
}

interface SoftruckVehicleResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: {
      plate: string;
      brand_name: string;
      model_name: string;
    };
  }>;
}

interface SoftruckDeviceAssociationResponse {
  data: Array<{
    relationships: {
      devices: {
        id: string;
      };
      vehicles: {
        id: string;
      };
    };
  }>;
}

interface SoftruckTrackingResponse {
  data: {
    type: string;
    attributes: {
      ign: boolean;
      act: number;
      spd: number;
      geometry: {
        coordinates: [number, number];
      };
    };
  };
}

export class RastreamentoSoftruck {
  private readonly logger = new Logger(RastreamentoSoftruck.name);
  private softruckToken = process.env.SOFTRUCK_TOKEN;

  /** Mutex para evitar logins simultâneos */
  private loginPromise: Promise<void> | null = null;

  /** Cache de vehicle data por chassi */
  private vehicleCache = new Map<string, CacheEntry<{ id: string; plate: string; brandName: string; modelName: string }>>();

  /** Cache de device ID por vehicle ID */
  private deviceCache = new Map<string, CacheEntry<string>>();

  constructor() {
    this.logger.log('Módulo de rastreamento Softruck inicializado');
  }

  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
    cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
  }

  private formatError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return (
        `HTTP ${error.response?.status ?? 'N/A'} | ` +
        `URL: ${error.config?.url ?? 'N/A'} | ` +
        `Body: ${JSON.stringify(error.response?.data ?? null)}`
      );
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private buildSoftruckUrl(path: string): string {
    const baseUrl = process.env.SOFTRUCK_API_BASE_URL;

    if (!baseUrl) {
      throw new InternalServerErrorException(
        'SOFTRUCK_API_BASE_URL não configurada',
      );
    }

    const normalizedBaseUrl = baseUrl.endsWith('/')
      ? baseUrl.slice(0, -1)
      : baseUrl;

    return `${normalizedBaseUrl}/${path.replace(/^\//, '')}`;
  }

  private getRequestHeaders() {
    return {
      Authorization: `Bearer ${this.softruckToken}`,
      'public-key': process.env.PUBLIC_KEY_SOFTRUCK,
    };
  }

  private isAuthError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    const status = error.response?.status;
    return status === 401 || status === 403;
  }

  private async autenticarSoftruck(): Promise<void> {
    // Mutex: se já estiver autenticando, reutiliza a mesma promise
    if (this.loginPromise) {
      await this.loginPromise;
      return;
    }

    this.loginPromise = this.executeAutenticarSoftruck();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async executeAutenticarSoftruck(): Promise<void> {
    const username = process.env.USERNAME_SOFTRUCK;
    const password = process.env.PASSWORD_SOFTRUCK;

    if (!username || !password) {
      this.logger.error(
        `Credenciais ausentes — USERNAME="${username ?? '(vazio)'}" PASSWORD="${password ? '***' : '(vazio)'}"`,
      );
      throw new InternalServerErrorException(
        'Credenciais USERNAME/PASSWORD da Softruck não configuradas',
      );
    }

    const loginUrl = this.buildSoftruckUrl('/auth/login');
    const publicKey = process.env.PUBLIC_KEY_SOFTRUCK;

    try {
      const response = await axios.post<{
        data?: {
          token?: string;
          refresh_token?: string;
        };
      }>(
        loginUrl,
        { username, password },
        {
          headers: {
            'public-key': publicKey,
          },
          timeout: SOFTRUCK_REQUEST_TIMEOUT,
        },
      );

      this.logger.debug(
        `[LOGIN] Resposta HTTP ${response.status}: ${JSON.stringify(response.data)}`,
      );

      const token = response.data?.data?.token;

      if (!token) {
        this.logger.error(
          `[LOGIN] Token ausente na resposta: ${JSON.stringify(response.data)}`,
        );
        throw new InternalServerErrorException(
          'Token não retornado no login da Softruck',
        );
      }

      this.softruckToken = token;
      this.logger.log('Token da Softruck atualizado com sucesso');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `[LOGIN] Falha na autenticação Softruck:\n` +
            `  → Status : ${error.response?.status ?? 'N/A'}\n` +
            `  → Mensagem: ${error.response?.data?.error?.message ?? JSON.stringify(error.response?.data) ?? error.message}`,
        );
        throw new InternalServerErrorException(
          `Falha no login Softruck (${error.response?.status}): ${error.response?.data?.error?.message ?? 'Erro desconhecido'}`,
        );
      }
      this.logger.error(
        `[LOGIN] Erro inesperado ao autenticar na Softruck: ${this.formatError(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao autenticar na API da Softruck',
      );
    }
  }

  private async executarComReautenticacao<T>(
    request: () => Promise<T>,
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!this.isAuthError(error)) {
        throw error;
      }

      this.logger.warn(
        'Token da Softruck expirado/inválido. Realizando novo login.',
      );

      await this.autenticarSoftruck();
      return request();
    }
  }

  // Consultar a última posição do veículo via Softruck
  async ultimaPosicaoSoftruck(
    chassi: string,
  ): Promise<UltimaPosicaoSoftruckResponse> {
    try {
      // STEP 1: Obter vehicle_id e dados do veículo pelo chassi
      const vehicleData = await this.obterVehicleId(chassi);

      // STEP 2: Obter device_id através da associação
      const deviceId = await this.obterDeviceId(vehicleData.id);

      // STEP 3: Obter dados de rastreamento
      const trackingData = await this.obterDadosRastreamento(
        vehicleData.id,
        deviceId,
      );

      // Retornar DTO formatado com dados do veículo e rastreamento
      return this.mapearUltimaPosicaoSoftruck(trackingData, vehicleData);
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      this.logger.error(
        `Erro ao consultar última posição: ${this.formatError(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao consultar última posição do veículo',
      );
    }
  }

  // STEP 1: Obter vehicle_id pelo chassi
  private async obterVehicleId(chassi: string): Promise<{
    id: string;
    plate: string;
    brandName: string;
    modelName: string;
  }> {
    // Verifica cache primeiro
    const cached = this.getCached(this.vehicleCache, chassi);
    if (cached) {
      this.logger.debug(`[Cache HIT] Vehicle data para chassi: ${chassi}`);
      return cached;
    }

    try {
      const response = await this.executarComReautenticacao(() =>
        axios.get<SoftruckVehicleResponse>(this.buildSoftruckUrl('/vehicles'), {
          params: {
            search: chassi,
          },
          headers: this.getRequestHeaders(),
          timeout: SOFTRUCK_REQUEST_TIMEOUT,
        }),
      );

      if (
        !response.data ||
        !response.data.data ||
        response.data.data.length === 0
      ) {
        throw new InternalServerErrorException(
          'Veículo não encontrado na base Softruck',
        );
      }

      const vehicleData = response.data.data[0];
      const vehicleId = vehicleData.id;
      const plate = vehicleData.attributes.plate;
      const brandName = vehicleData.attributes.brand_name;
      const modelName = vehicleData.attributes.model_name;

      this.logger.log(`Vehicle ID obtido: ${vehicleId} para chassi: ${chassi}`);

      const result = { id: vehicleId, plate, brandName, modelName };
      this.setCache(this.vehicleCache, chassi, result);
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      this.logger.error(`Erro ao obter vehicle_id: ${this.formatError(error)}`);
      throw new InternalServerErrorException(
        'Erro ao buscar veículo pelo chassi',
      );
    }
  }

  // STEP 2: Obter device_id através da associação
  private async obterDeviceId(vehicleId: string): Promise<string> {
    // Verifica cache primeiro
    const cached = this.getCached(this.deviceCache, vehicleId);
    if (cached) {
      this.logger.debug(`[Cache HIT] Device ID para vehicle: ${vehicleId}`);
      return cached;
    }

    try {
      const response = await this.executarComReautenticacao(() =>
        axios.get<SoftruckDeviceAssociationResponse>(
          this.buildSoftruckUrl(`/vehicles/${vehicleId}/associations/devices`),
          {
            headers: this.getRequestHeaders(),
            timeout: SOFTRUCK_REQUEST_TIMEOUT,
          },
        ),
      );

      if (
        !response.data ||
        !response.data.data ||
        response.data.data.length === 0
      ) {
        throw new InternalServerErrorException(
          'Dispositivo não associado ao veículo',
        );
      }

      const deviceId = response.data.data[0].relationships.devices.id;
      this.logger.log(
        `Device ID obtido: ${deviceId} para vehicle: ${vehicleId}`,
      );
      this.setCache(this.deviceCache, vehicleId, deviceId);
      return deviceId;
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      this.logger.error(`Erro ao obter device_id: ${this.formatError(error)}`);
      throw new InternalServerErrorException(
        'Erro ao buscar dispositivo associado ao veículo',
      );
    }
  }

  // STEP 3: Obter dados de rastreamento
  private async obterDadosRastreamento(
    vehicleId: string,
    deviceId: string,
  ): Promise<SoftruckTrackingResponse> {
    try {
      const response = await this.executarComReautenticacao(() =>
        axios.get<SoftruckTrackingResponse>(
          this.buildSoftruckUrl(`/vehicles/${vehicleId}/tracking/${deviceId}`),
          {
            headers: this.getRequestHeaders(),
            timeout: SOFTRUCK_REQUEST_TIMEOUT,
          },
        ),
      );

      if (!response.data || !response.data.data) {
        throw new InternalServerErrorException(
          'Dados de rastreamento não disponíveis',
        );
      }

      this.logger.log(
        `Dados de rastreamento obtidos para vehicle: ${vehicleId}`,
      );
      return response.data;
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      this.logger.error(
        `Erro ao obter dados de rastreamento: ${this.formatError(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao buscar dados de rastreamento',
      );
    }
  }

  // Mapear resposta para DTO
  private mapearUltimaPosicaoSoftruck(
    data: SoftruckTrackingResponse,
    vehicleData: {
      id: string;
      plate: string;
      brandName: string;
      modelName: string;
    },
  ): UltimaPosicaoSoftruckResponse {
    const attributes = data.data.attributes;

    // Converter timestamp (act) para formato dd/MM/yyyy HH:mm
    const date = this.formatarData(attributes.act);

    // Extrair coordenadas [longitude, latitude]
    const [longitude, latitude] = attributes.geometry.coordinates;

    return {
      date,
      ign: attributes.ign,
      speed: attributes.spd,
      coordinates: {
        latitude,
        longitude,
      },
      plate: vehicleData.plate,
      brandName: vehicleData.brandName,
      modelName: vehicleData.modelName,
    };
  }

  // Formatar timestamp Unix para dd/MM/yyyy HH:mm
  private formatarData(timestamp: number): string {
    const date = new Date(timestamp * 1000); // Converter de segundos para milissegundos

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }
}

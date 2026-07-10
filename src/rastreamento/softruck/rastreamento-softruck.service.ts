import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import {
  BaseOrigin,
  TokenResolverService,
} from 'src/shared/token-resolver.service';
import { UltimaPosicaoSoftruckResponse } from './dto/ultima-posicao.dto';
import {
  CacheEntry,
  JwtPayload,
  SoftruckDeviceAssociationResponse,
  SoftruckTrackingResponse,
  SoftruckVehicleResponse,
  TokenEntry,
} from './interfaces/softruck-api.interface';
import { mapearUltimaPosicaoSoftruck } from './mappers/ultima-posicao.mapper';
import {
  SoftruckByKeysApiResponse,
  SoftruckGeomFeatureCollection,
} from './interfaces/softruck-trajectories.interface';

/** Timeout padrão para chamadas HTTP à API Softruck (em ms) */
const SOFTRUCK_REQUEST_TIMEOUT = 15_000;

/** TTL do cache de vehicle/device em ms (10 minutos) */
const CACHE_TTL = 10 * 60 * 1000;

/** TTL do token JWT em ms (menos buffer para renovar antecipadamente) */
const TOKEN_TTL_BUFFER_MS = 60_000; // 1 minuto antes de expirar

@Injectable()
export class RastreamentoSoftruck {
  private readonly logger = new Logger(RastreamentoSoftruck.name);
  private readonly tokenResolver: TokenResolverService;
  private softruckTokenByBase = new Map<BaseOrigin, TokenEntry>();
  private static readonly MAX_LOG_PAYLOAD_LENGTH = 1500;

  /** Axios instance com HTTP/HTTPS agents configurados */
  private axiosInstance: AxiosInstance;

  /** Mutex por base para evitar logins simultâneos */
  private loginPromiseByBase = new Map<BaseOrigin, Promise<void>>();

  /** Cache de vehicle data por chassi */
  private vehicleCache = new Map<
    string,
    CacheEntry<{
      id: string;
      plate: string;
      brandName: string;
      modelName: string;
    }>
  >();

  /** Cache de IDs de tracking por vehicle ID */
  private deviceCache = new Map<
    string,
    CacheEntry<{
      vehicleId: string;
      deviceId: string;
    }>
  >();

  constructor(tokenResolver: TokenResolverService) {
    this.tokenResolver = tokenResolver;

    this.axiosInstance = axios.create({
      httpAgent: new HttpAgent({
        keepAlive: true,
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: SOFTRUCK_REQUEST_TIMEOUT,
      }),
      httpsAgent: new HttpsAgent({
        keepAlive: true,
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: SOFTRUCK_REQUEST_TIMEOUT,
      }),
    });
  }

  private getCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
  ): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCache<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    data: T,
  ): void {
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

  private stringifyForLog(data: unknown): string {
    const serialized = JSON.stringify(data);

    if (!serialized) {
      return '(vazio)';
    }

    if (serialized.length <= RastreamentoSoftruck.MAX_LOG_PAYLOAD_LENGTH) {
      return serialized;
    }

    return `${serialized.slice(0, RastreamentoSoftruck.MAX_LOG_PAYLOAD_LENGTH)}... [truncated ${serialized.length - RastreamentoSoftruck.MAX_LOG_PAYLOAD_LENGTH} chars]`;
  }

  private logExternalRequest(
    baseOrigin: BaseOrigin,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
  ): void {
    const payloadLabel = method === 'GET' ? 'params' : 'body';
    const details = payload
      ? ` | ${payloadLabel}: ${this.stringifyForLog(payload)}`
      : '';
    this.logger.debug(`[${baseOrigin}] Softruck → ${method} ${url}${details}`);
  }

  private logExternalResponse(
    baseOrigin: BaseOrigin,
    method: 'GET' | 'POST',
    url: string,
    status: number,
    data: unknown,
  ): void {
    this.logger.debug(
      `[${baseOrigin}] Softruck ← ${method} ${url} | status=${status} | response: ${this.stringifyForLog(data)}`,
    );
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

  private maskSecret(value?: string): string {
    if (!value) return '(vazio)';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  private getRequestHeaders(
    baseOrigin: BaseOrigin,
    publicKey: string,
    overrideToken?: string,
  ) {
    let token: string;

    if (overrideToken) {
      token = overrideToken;
    } else {
      const tokenEntry = this.softruckTokenByBase.get(baseOrigin);
      if (!tokenEntry) {
        throw new InternalServerErrorException(
          `Token Softruck não disponível para base ${baseOrigin}`,
        );
      }
      token = tokenEntry.token;
    }

    return {
      Authorization: `Bearer ${token}`,
      'public-key': publicKey,
    };
  }

  /**
   * Decodificar JWT sem validar assinatura para extrair claims
   */
  private decodeJwt(token: string): JwtPayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
      return JSON.parse(payload) as JwtPayload;
    } catch (error) {
      this.logger.debug(`Falha ao decodificar JWT: ${error}`);
      return null;
    }
  }

  /**
   * Verificar se token JWT está expirado ou próximo de expirar
   */
  private isTokenExpired(token: string): boolean {
    const payload = this.decodeJwt(token);
    if (!payload?.exp) return false;

    const expiresAtMs = payload.exp * 1000;
    const now = Date.now();

    return now > expiresAtMs - TOKEN_TTL_BUFFER_MS;
  }

  /**
   * Obter token válido para base, renovando se necessário
   */
  private getValidToken(baseOrigin: BaseOrigin): string | null {
    const tokenEntry = this.softruckTokenByBase.get(baseOrigin);
    if (!tokenEntry) return null;

    if (!this.isTokenExpired(tokenEntry.token)) {
      return tokenEntry.token;
    }

    this.logger.debug(
      `[${baseOrigin}] Token expirado, será renovado no próximo login`,
    );
    this.softruckTokenByBase.delete(baseOrigin);
    return null;
  }

  private isAuthError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    const status = error.response?.status;
    return status === 401 || status === 403;
  }

  private async autenticarSoftruck(
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<void> {
    const existingLogin = this.loginPromiseByBase.get(baseOrigin);
    if (existingLogin) {
      await existingLogin;
      return;
    }

    const loginPromise = this.executeAutenticarSoftruck(baseOrigin, publicKey);
    this.loginPromiseByBase.set(baseOrigin, loginPromise);

    try {
      await loginPromise;
    } finally {
      this.loginPromiseByBase.delete(baseOrigin);
    }
  }

  private async executeAutenticarSoftruck(
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<void> {
    const usernameKey = this.tokenResolver.getTokenKey(
      baseOrigin,
      'softruckUsername',
    );
    const passwordKey = this.tokenResolver.getTokenKey(
      baseOrigin,
      'softruckPassword',
    );
    const username = process.env[usernameKey];
    const password = process.env[passwordKey];

    if (!username || !password) {
      this.logger.error(
        `[${baseOrigin}] Credenciais ausentes — ${usernameKey}="${username ?? '(vazio)'}" ${passwordKey}="${password ? '***' : '(vazio)'}"`,
      );
      throw new InternalServerErrorException(
        `Credenciais ${usernameKey}/${passwordKey} da Softruck não configuradas`,
      );
    }

    const loginUrl = this.buildSoftruckUrl('/auth/login');
    const loginPayload = { username, password: '***' };
    this.logger.log(
      `[${baseOrigin}] Iniciando autenticação Softruck com public-key=${this.maskSecret(publicKey)}`,
    );
    this.logExternalRequest(baseOrigin, 'POST', loginUrl, loginPayload);

    try {
      const response = await this.axiosInstance.post<{
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

      this.logExternalResponse(
        baseOrigin,
        'POST',
        loginUrl,
        response.status,
        response.data,
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

      const payload = this.decodeJwt(token);
      const expiresAt =
        payload?.exp ? payload.exp * 1000 : Date.now() + CACHE_TTL;

      this.softruckTokenByBase.set(baseOrigin, { token, expiresAt });
      this.logger.log(
        `[${baseOrigin}] Token Softruck atualizado (token=${this.maskSecret(token)}, exp=${new Date(expiresAt).toISOString()})`,
      );
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
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!this.isAuthError(error)) {
        throw error;
      }

      this.logger.warn(
        `[${baseOrigin}] Token Softruck expirado/inválido. Realizando novo login.`,
      );

      await this.autenticarSoftruck(baseOrigin, publicKey);
      return request();
    }
  }

  // STEP 1: Obter vehicle_id pelo chassi
  private async obterVehicleId(
    chassi: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
    tokenOverride?: string,
  ): Promise<{ id: string; plate: string; brandName: string; modelName: string }> {
    const cached = this.getCached(this.vehicleCache, chassi);
    if (cached) {
      this.logger.debug(`[Cache HIT] Vehicle data para chassi: ${chassi}`);
      return cached;
    }

    try {
      const url = this.buildSoftruckUrl('/vehicles');
      const params = { search: chassi };
      this.logExternalRequest(baseOrigin, 'GET', url, params);

      const response = await this.executarComReautenticacao(
        () =>
          this.axiosInstance.get<SoftruckVehicleResponse>(url, {
            params,
            headers: this.getRequestHeaders(baseOrigin, publicKey, tokenOverride),
            timeout: SOFTRUCK_REQUEST_TIMEOUT,
          }),
        baseOrigin,
        publicKey,
      );

      this.logExternalResponse(
        baseOrigin,
        'GET',
        url,
        response.status,
        response.data,
      );

      if (!response.data?.data?.length) {
        throw new InternalServerErrorException(
          'Veículo não encontrado na base Softruck',
        );
      }

      this.logger.log(
        `Vehicle encontrado para chassi ${chassi}: ${JSON.stringify(response.data.data[0])}`,
      );

      const vehicleData = response.data.data[0];
      const result = {
        id: vehicleData.id,
        plate: vehicleData.attributes.plate,
        brandName: vehicleData.attributes.brand_name,
        modelName: vehicleData.attributes.model_name,
      };

      this.logger.log(`Vehicle ID obtido: ${result.id} para chassi: ${chassi}`);
      this.setCache(this.vehicleCache, chassi, result);
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(`Erro ao obter vehicle_id: ${this.formatError(error)}`);
      throw new InternalServerErrorException('Erro ao buscar veículo pelo chassi');
    }
  }

  // STEP 2: Obter device_id através da associação
  private async obterDeviceId(
    vehicleId: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
    tokenOverride?: string,
  ): Promise<{ vehicleId: string; deviceId: string }> {
    try {
      const url = this.buildSoftruckUrl(
        `/vehicles/${vehicleId}/associations/devices`,
      );
      this.logExternalRequest(baseOrigin, 'GET', url);

      const response = await this.executarComReautenticacao(
        () =>
          this.axiosInstance.get<SoftruckDeviceAssociationResponse>(url, {
            headers: this.getRequestHeaders(baseOrigin, publicKey, tokenOverride),
            timeout: SOFTRUCK_REQUEST_TIMEOUT,
          }),
        baseOrigin,
        publicKey,
      );

      this.logExternalResponse(
        baseOrigin,
        'GET',
        url,
        response.status,
        response.data,
      );

      if (!response.data?.data?.length) {
        throw new InternalServerErrorException(
          'Dispositivo não associado ao veículo',
        );
      }

      const mainDevices = response.data.data.filter(
        (a) => a.attributes.is_main_device === true,
      );

      if (!mainDevices.length) {
        throw new InternalServerErrorException(
          'Associação principal (is_main_device=true) não encontrada para o veículo',
        );
      }

      const selectedAssociation = mainDevices.reduce((maisRecente, atual) =>
        atual.attributes.created_at > maisRecente.attributes.created_at
          ? atual
          : maisRecente,
      );

      this.logger.log(
        `Associação principal selecionada para vehicle: ${vehicleId}: ${selectedAssociation.id} (created_at=${selectedAssociation.attributes.created_at})`,
      );

      const trackingVehicleId = selectedAssociation.id;
      const deviceId = selectedAssociation.relationships.device.id;

      if (!trackingVehicleId || !deviceId) {
        throw new InternalServerErrorException(
          'IDs de associação/dispositivo inválidos na resposta da Softruck',
        );
      }

      this.logger.log(
        `IDs de tracking obtidos: trackingVehicleId=${trackingVehicleId} deviceId=${deviceId} para vehicle: ${vehicleId}`,
      );
      const result = { vehicleId: trackingVehicleId, deviceId };
      return result;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
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
    baseOrigin: BaseOrigin,
    publicKey: string,
    tokenOverride?: string,
  ): Promise<SoftruckTrackingResponse> {
    try {
      const response = await this.executarComReautenticacao(
        () =>
          this.axiosInstance.get<SoftruckTrackingResponse>(
            this.buildSoftruckUrl(`/vehicles/${vehicleId}/tracking/${deviceId}`),
            {
              headers: this.getRequestHeaders(baseOrigin, publicKey, tokenOverride),
              timeout: SOFTRUCK_REQUEST_TIMEOUT,
            },
          ),
        baseOrigin,
        publicKey,
      );

      this.logger.debug(
        `[${baseOrigin}] Softruck /vehicles/${vehicleId}/tracking/${deviceId} response status=${response.status} body=${this.stringifyForLog(response.data)}`,
      );

      if (!response.data?.data) {
        throw new InternalServerErrorException(
          'Dados de rastreamento não disponíveis',
        );
      }

      this.logger.log(
        `Dados de rastreamento obtidos para vehicle: ${vehicleId}`,
      );
      return response.data;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `Erro ao obter dados de rastreamento: ${this.formatError(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao buscar dados de rastreamento',
      );
    }
  }

  // Resolve vehicleId e deviceId para uso em operações de histórico
  async resolveVehicleAndDevice(
    chassi: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<{
    vehicleData: { id: string; plate: string; brandName: string; modelName: string };
    deviceData: { vehicleId: string; deviceId: string };
  }> {
    const storedToken = this.softruckTokenByBase.get(baseOrigin);
    if (storedToken) {
      const validToken = this.getValidToken(baseOrigin);
      if (!validToken) {
        await this.autenticarSoftruck(baseOrigin, publicKey);
      }
    } else {
      await this.autenticarSoftruck(baseOrigin, publicKey);
    }

    const vehicleData = await this.obterVehicleId(chassi, baseOrigin, publicKey);
    const deviceData = await this.obterDeviceId(vehicleData.id, baseOrigin, publicKey);
    return { vehicleData, deviceData };
  }

  // Busca trajetória diária via /trajectories/by-keys
  async buscarByKeysPorAcc(
    vehicleId: string,
    deviceId: string,
    acc: number,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<SoftruckByKeysApiResponse | null> {
    try {
      const url = this.buildSoftruckUrl(`/vehicles/${vehicleId}/trajectories/by-keys`);
      const params = {
        'filters[acc][eq]': acc,
        'filters[did][eq]': deviceId,
      };
      this.logExternalRequest(baseOrigin, 'GET', url, params);

      const response = await this.executarComReautenticacao(
        () =>
          this.axiosInstance.get<SoftruckByKeysApiResponse>(url, {
            params,
            headers: this.getRequestHeaders(baseOrigin, publicKey),
            timeout: SOFTRUCK_REQUEST_TIMEOUT,
          }),
        baseOrigin,
        publicKey,
      );

      this.logExternalResponse(
        baseOrigin,
        'GET',
        url,
        response.status,
        response.data,
      );

      return response.data ?? null;
    } catch (error) {
      if (this.isAuthError(error)) throw error;
      this.logger.warn(
        `[${baseOrigin}] by-keys acc=${acc} sem dados: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  // Busca pontos GPS detalhados via /trajectories/geom
  async buscarGeomPorAcc(
    vehicleId: string,
    deviceId: string,
    enterpriseId: string,
    acc: number,
    baseOrigin: BaseOrigin,
    publicKey: string,
  ): Promise<SoftruckGeomFeatureCollection | null> {
    try {
      const url = this.buildSoftruckUrl(`/vehicles/${vehicleId}/trajectories/geom`);
      const params = {
        'filters[acc][eq]': acc,
        'filters[did][eq]': deviceId,
        'filters[eid][eq]': enterpriseId,
      };
      this.logExternalRequest(baseOrigin, 'GET', url, params);

      const response = await this.executarComReautenticacao(
        () =>
          this.axiosInstance.get<{ data: SoftruckGeomFeatureCollection }>(url, {
            params,
            headers: this.getRequestHeaders(baseOrigin, publicKey),
            timeout: SOFTRUCK_REQUEST_TIMEOUT,
          }),
        baseOrigin,
        publicKey,
      );

      this.logExternalResponse(
        baseOrigin,
        'GET',
        url,
        response.status,
        response.data,
      );

      return response.data?.data ?? null;
    } catch (error) {
      if (this.isAuthError(error)) throw error;
      this.logger.warn(
        `[${baseOrigin}] geom acc=${acc} sem dados: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  // Consultar a última posição do veículo via Softruck
  async ultimaPosicaoSoftruck(
    chassi: string,
    baseOrigin: BaseOrigin,
    publicKey: string,
    tokenOverride?: string,
  ): Promise<UltimaPosicaoSoftruckResponse> {
    try {
      const storedToken = this.softruckTokenByBase.get(baseOrigin);
      this.logger.debug(
        `[${baseOrigin}] ultimaPosicaoSoftruck chassi=${chassi} token=${this.maskSecret(tokenOverride ?? storedToken?.token)} publicKey=${this.maskSecret(publicKey)}`,
      );

      if (!tokenOverride && storedToken) {
        const validToken = this.getValidToken(baseOrigin);
        if (!validToken) {
          this.logger.debug(
            `[${baseOrigin}] Token expirado ou próximo de expirar. Fazendo novo login.`,
          );
          await this.autenticarSoftruck(baseOrigin, publicKey);
        }
      } else if (!tokenOverride && !storedToken) {
        await this.autenticarSoftruck(baseOrigin, publicKey);
      }

      const vehicleData = await this.obterVehicleId(
        chassi,
        baseOrigin,
        publicKey,
        tokenOverride,
      );

      const deviceId = await this.obterDeviceId(
        vehicleData.id,
        baseOrigin,
        publicKey,
        tokenOverride,
      );

      const trackingData = await this.obterDadosRastreamento(
        deviceId.vehicleId,
        deviceId.deviceId,
        baseOrigin,
        publicKey,
        tokenOverride,
      );

      const mapped = mapearUltimaPosicaoSoftruck(trackingData, vehicleData);
      return mapped;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `Erro ao consultar última posição: ${this.formatError(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao consultar última posição do veículo',
      );
    }
  }
}

// Re-export public types for convenience
export type { UltimaPosicaoSoftruckResponse } from './dto/ultima-posicao.dto';


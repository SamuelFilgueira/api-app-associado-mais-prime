import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TrajetoriaSoftruckRota } from '../dto/trajetorias.dto';
import { RedisService } from '../../redis.service';
import { formatarEnderecoNominatim, NominatimAddress } from '../utils/endereco-formatter.helper';
import { normalizarCoord, normalizarCoordParaCache } from '../utils/geo.utils';
import { retry, sleep } from '../utils/retry.helper';

const GEOCODING_DELAY_MS = 1100;
const GEOCODING_TIMEOUT_MS = 4_000;
const GEOCODING_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  'SistemaTrajetorias/1.0 contato@empresa.com';

@Injectable()
export class GeoCodingService {
  private readonly logger = new Logger(GeoCodingService.name);
  private readonly memoryCache = new Map<string, string>();

  constructor(private readonly redisService: RedisService) {}

  async geocodificarCoordenadas(
    rotas: TrajetoriaSoftruckRota[],
  ): Promise<Map<string, string>> {
    const startedAt = Date.now();
    const resultado = new Map<string, string>();
    const cacheBuckets = new Map<
      string,
      { lat: number; lng: number; displayKeys: Set<string> }
    >();
    let totalCoordenadas = 0;
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const rota of rotas) {
      this.registrarCoordenada(
        cacheBuckets,
        rota.startPosition.latitude,
        rota.startPosition.longitude,
      );
      totalCoordenadas += 1;

      this.registrarCoordenada(
        cacheBuckets,
        rota.endPosition.latitude,
        rota.endPosition.longitude,
      );
      totalCoordenadas += 1;
    }

    const totalUnicas = cacheBuckets.size;
    const requestsEvitadas = totalCoordenadas - totalUnicas;
    this.logger.log(
      `[Geocoding] totalCoordenadas=${totalCoordenadas} totalUnicas=${totalUnicas} requestsEvitadas=${requestsEvitadas}`,
    );

    const buckets = Array.from(cacheBuckets.entries());

    for (let index = 0; index < buckets.length; index += 1) {
      const [cacheKey, bucket] = buckets[index];
      const cachedAddress = await this.getEnderecoFromCache(cacheKey);

      if (cachedAddress) {
        cacheHits += 1;
        for (const displayKey of bucket.displayKeys) {
          resultado.set(displayKey, cachedAddress);
        }
        continue;
      }

      cacheMisses += 1;
      const endereco = await this.reverseGeocode(bucket.lat, bucket.lng, cacheKey);

      if (endereco) {
        await this.persistEndereco(cacheKey, endereco);
        for (const displayKey of bucket.displayKeys) {
          resultado.set(displayKey, endereco);
        }
      }

      if (index < buckets.length - 1) {
        await sleep(GEOCODING_DELAY_MS);
      }
    }

    const elapsed = Date.now() - startedAt;
    this.logger.log(
      `[Geocoding] concluído em ${elapsed}ms cacheHits=${cacheHits} cacheMisses=${cacheMisses} resolvidos=${resultado.size}`,
    );

    return resultado;
  }

  private registrarCoordenada(
    cacheBuckets: Map<string, { lat: number; lng: number; displayKeys: Set<string> }>,
    lat: number,
    lng: number,
  ): void {
    if (!this.coordenadasValidas(lat, lng)) {
      this.logger.warn(`Coordenadas inválidas ignoradas: lat=${lat} lng=${lng}`);
      return;
    }

    const cacheKey = normalizarCoordParaCache(lat, lng);
    const displayKey = normalizarCoord(lat, lng);
    const existing = cacheBuckets.get(cacheKey);

    if (existing) {
      existing.displayKeys.add(displayKey);
      return;
    }

    cacheBuckets.set(cacheKey, {
      lat,
      lng,
      displayKeys: new Set([displayKey]),
    });
  }

  private async getEnderecoFromCache(cacheKey: string): Promise<string | null> {
    const memoryValue = this.memoryCache.get(cacheKey);
    if (memoryValue) {
      this.logger.debug(`[Geocoding] cache hit memória ${cacheKey}`);
      return memoryValue;
    }

    const redisKey = this.buildRedisKey(cacheKey);
    const redisValue = await this.redisService.getClient().get(redisKey);
    if (redisValue) {
      this.memoryCache.set(cacheKey, redisValue);
      this.logger.debug(`[Geocoding] cache hit redis ${cacheKey}`);
      return redisValue;
    }

    this.logger.debug(`[Geocoding] cache miss ${cacheKey}`);
    return null;
  }

  private async persistEndereco(cacheKey: string, endereco: string): Promise<void> {
    this.memoryCache.set(cacheKey, endereco);
    await this.redisService
      .getClient()
      .set(this.buildRedisKey(cacheKey), endereco, 'EX', GEOCODING_CACHE_TTL_SECONDS);
  }

  private async reverseGeocode(
    lat: number,
    lng: number,
    cacheKey: string,
  ): Promise<string | null> {
    const startedAt = Date.now();

    try {
      this.logger.debug(`[Geocoding] request enviada ${cacheKey}`);
      const response = await retry(
        () =>
          axios.get('https://nominatim.openstreetmap.org/reverse', {
            params: {
              lat,
              lon: lng,
              format: 'jsonv2',
              addressdetails: 1,
            },
            headers: {
              'User-Agent': NOMINATIM_USER_AGENT,
            },
            timeout: GEOCODING_TIMEOUT_MS,
          }),
        {
          attempts: 3,
          baseDelayMs: 500,
          shouldRetry: (error) => this.isRetryableError(error),
          onRetry: (error, attempt, nextDelayMs) => {
            const status = axios.isAxiosError(error)
              ? error.response?.status ?? 'N/A'
              : 'N/A';
            this.logger.warn(
              `[Geocoding] retry ${attempt}/3 ${cacheKey} status=${status} nextDelay=${nextDelayMs}ms`,
            );
          },
        },
      );

      const address = response.data?.address as NominatimAddress | undefined;
      const endereco = address ? formatarEnderecoNominatim(address) : null;
      const elapsed = Date.now() - startedAt;

      if (!endereco) {
        this.logger.warn(
          `[Geocoding] endereço não encontrado ${cacheKey} em ${elapsed}ms`,
        );
        return null;
      }

      this.logger.debug(`[Geocoding] resolvido ${cacheKey} em ${elapsed}ms`);
      return endereco;
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      const status = axios.isAxiosError(error)
        ? error.response?.status ?? 'N/A'
        : 'N/A';
      this.logger.warn(
        `[Geocoding] falha ${cacheKey} status=${status} tempo=${elapsed}ms erro=${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    if (!error.response) {
      return true;
    }

    return [408, 425, 429, 500, 502, 503, 504].includes(error.response.status);
  }

  private coordenadasValidas(lat: number, lng: number): boolean {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  }

  private buildRedisKey(cacheKey: string): string {
    return `geo:${cacheKey}`;
  }
}
